"use strict";

var clusterphone  = require("clusterphone").ns("socketio-cluster"),
    Promise       = require("bluebird"),
    hotpotato     = require("hotpotato"),
    cluster       = require("cluster"),
    shimmer       = require("shimmer"),
    url           = require("url"),
    debug         = require("debug")("socketio-cluster:" + (cluster.isMaster ? "master" : "worker" + cluster.worker.id));

// TODO: Support multiple socket.io instances.

var bouncer = hotpotato("socketio-cluster");

function patchEngineIO(engineIo) {
  shimmer.wrap(engineIo, "handleRequest", function(original) {
    return function(req, res) {
      // Short-circuit, if this is a proxied request we accept it no matter
      // what. This is because hotpotato doesn't support passing off a request
      // that was already passed off ;)
      if (req.headers["x-hotpotato-worker"]) {
        return original.call(this, req, res);
      }

      debug("Intercepting engine.io handleRequest");

      this.prepare(req);
      var sid = req._query.sid;

      // If this request doesn't yet have a sid, *or* it bears a sid we handle
      // then we allow it through.
      if (!sid || this.clients.hasOwnProperty(sid)) {
        debug("Allowing this worker to handle request.", sid);
        return original.call(this, req, res);
      }

      // Okay, we got a request for a sid we don't recognize. Pass it off to
      // master to be rerouted.
      debug("Passing a socket.io request off to be re-routed.", sid);

      try {
        bouncer.passRequest(req, res);
      } catch(e) {
        debug("Failed to pass socket.io sid " + sid + " request off.", e.message, e.stack);
        res.writeHead(503);
        res.end();
      }
    };
  });

  shimmer.wrap(engineIo, "handleUpgrade", function(original) {
    return function(req, socket, head) {
      debug("Intercepting engine.io handleUpgrade");

      this.prepare(req);
      var sid = req._query.sid;

      if (!sid || this.clients.hasOwnProperty(sid)) {
        debug("Allowing this worker to handle upgrade.", sid);
        return original.call(this, req, socket, head);
      }

      debug("Passing a socket.io upgrade off to be re-routed.");
      bouncer.passUpgrade(req, socket, head);
    };
  });
}

function patchSocketIO(socketIo) {
  if (!socketIo) {
    throw new Error("No socket.io library provided. Correct usage: require('socketio-cluster')(require('socket.io'));");
  }

  // TODO: use Symbol if available for safety.
  if (socketIo.__socketIoClusterer) {
    return socketIo;
  }
  socketIo.__socketIoClusterer = true;

  if (!socketIo.prototype.bind) {
    throw new Error("Unsupported version of Socket.IO provided. Please provide Socket.IO 1.0");
  }

  if (cluster.isWorker) {
    // Handles notifying the master of a new sid.
    var registerSid = function(socket, next) {
      debug("Registering sid " + socket.id + " with master.");
      clusterphone.sendToMaster("newsid", socket.id).ackd(next);

      socket.on("disconnect", function() {
        console.log("Socket disconnected.", arguments);
        debug("De-registering sid " + socket.id + " with master.");
        clusterphone.sendToMaster("delsid", socket.id);
      });
    };

    shimmer.wrap(socketIo.prototype, "attach", function(original) {
      return function(server) {
        debug("Patching socket.io Server#attach");
        bouncer.bindTo(server);

        this.use(registerSid);

        return original.apply(this, arguments);
      };
    });
  }

  shimmer.wrap(socketIo.prototype, "bind", function(original) {
    return function(engineIo) {
      debug("Patching socket.io Server#bind");
      patchEngineIO(engineIo);
      return original.apply(this, arguments);
    };
  });

  return socketIo;
}

module.exports = patchSocketIO;

if (cluster.isMaster) {
  var sessionIds = {};
  var workerSessions = {};
  var pendingSessions = {};

  module.exports.activeSockets = 0;
  module.exports.workerSessions = workerSessions;

  bouncer.router(function(method, reqUrl) {
    reqUrl = url.parse(reqUrl, true);
    var sid = reqUrl.query.sid;

    // TODO: check an LRU cache to ensure the session id wasn't recently binned.
    if (!sessionIds[sid]) {
      // Well, we can't find the session ID. That *might* not mean there's no
      // corresponding session in one of the workers though. Due to how engine.io
      // is currently implemented, I can't figure out a way to monkeypatch it
      // such that I can hold off the handshake response to the client whilst I
      // propagate the session ID to the master. This means another request may
      // have come in before the message has made it to master. Realistically,
      // this will probably only ever happen when load testing on localhost...
      // We still need to handle it though.
      // We have a registry of pending session ids as promises.
      debug("Don't have " + sid + " in registry. Going to try waiting for it.");

      var promise = new Promise(function(resolve) {
        pendingSessions[sid] = resolve;
      });

      return promise
        .timeout(5000)
        .catch(Promise.TimeoutError, function() {
          debug("Timed out waiting for pending session ID " + sid + " to be registered.");
          return null;
        })
        .then(function(result) {
          delete pendingSessions[sid];
          return result;
        });
    }
    return sessionIds[sid];
  });

  clusterphone.handlers.newsid = function(worker, sid, fd, ack) {
    var workerId = worker.id;

    debug("Tracking socket id " + sid + " for worker " + workerId);

    module.exports.activeSockets++;
    sessionIds[sid] = workerId;
    workerSessions[workerId].push(sid);

    if (pendingSessions[sid]) {
      pendingSessions[sid](workerId);
    }

    ack();
  };

  clusterphone.handlers.delsid = function(worker, sid, fd, cb) {
    debug("Deleting socket id " + sid);
    module.exports.activeSockets--;
    var workerId = sessionIds[sid];
    delete sessionIds[sid];
    if (workerId) {
      var idx = workerSessions[workerId].indexOf(sid);
      if (idx > -1) {
        workerSessions[workerId].splice(idx, 1);
      }
    }
    cb();
  };

  cluster.on("fork", function(worker) {
    workerSessions[worker.id] = [];
  });

  cluster.on("exit", function(worker) {
    var sessions = workerSessions[worker.id];
    delete workerSessions[worker.id];
    if (sessions) {
      sessions.forEach(function(session) {
        delete sessionIds[session];
      });
    }
  });
}
