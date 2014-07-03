"use strict";

var clusterphone  = require("clusterphone").ns("socketio-cluster"),
    hotpotato     = require("hotpotato"),
    cluster       = require("cluster"),
    shimmer       = require("shimmer"),
    url           = require("url"),
    debug         = require("debug")("socketio-cluster");

// TODO: Support multiple socket.io instances.

if (cluster.isMaster) {
  var sessionIds = {};
  var workerSessions = {};

  hotpotato.router = function(method, reqUrl, headers) {
    reqUrl = url.parse(reqUrl, true);
    var sid = reqUrl.query.sid;
    return sessionIds[sid];
  };

  clusterphone.handlers.newsid = function(data, fd, cb) {
    sessionIds[data.sid] = data.workerId;
    workerSessions[data.workerId].push(data.sid);
    cb();
  };

  clusterphone.handlers.delsid = function(sid, fd, cb) {
    var workerId = sessionIds[sid];
    delete sessionIds[sid];
    if (workerId) {
      var idx = workerSessions[workerId].indexOf(sid);
      if (idx > -1) {
        workerSessions[workerId] = workerSessions.splice(idx, 1);
      }
    }
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

function patchEngineIO(engineIo) {
  shimmer.wrap(engineIo, "handleRequest", function(original) {
    return function(req, res) {
      debug("Intercepting engine.io handleRequest");

      this.prepare(req);
      var sid = req._query.sid;

      // If this request doesn't yet have a sid, *or* it bears a sid we handle
      // then we allow it through.
      if (!sid || this.clients.hasOwnProperty(sid)) {
        debug("Allowing worker " + cluster.worker.id + " to handle request.", sid);
        return original.call(this, req, res);
      }

      // Okay, we got a request for a sid we don't recognize. Pass it off to
      // master to be rerouted.
      hotpotato.passConnection(req, res);
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
      clusterphone.sendToMaster("newsid", {
        sid: socket.id,
        workerId: cluster.worker.id
      }, next);

      socket.on("close", function() {
        clusterphone.sendToMaster("delsid", socket.id);
      });
    };

    shimmer.wrap(socketIo.prototype, "attach", function(original) {
      return function(server) {
        debug("Patching socket.io Server#attach");
        hotpotato.server(server);

        this.use(registerSid);

        return original.apply(this, arguments);
      }
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
