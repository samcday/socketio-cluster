var fs = require("fs");
var 
var os = require("os");
var debug = require("debug")("app");
var shimmer = require("shimmer");


// The idea is as follows:

// Patch handleRequest / handleUpgrade.
// When a request comes in, check if it already has an sid. If it does, and we don't own it, then send it to master to be dispatched elsewhere.
// If no sid, go through usual handshake, but notify master of the sid we now own before we let the transport handle the request.
// The master maintains a lookup table of *all* session ids and the corresponding worker who owns it.
// When the worker knows that a socket has closed, it will tell master so it can clean up session id lookup table.
// When a worker dies, master removes all session id entries for that worker.

// When master is handed a request that has a session id with no corresponding entry in lookup table, it will ping back to the master telling it to proceed.

// This approach should give us complete cluster support, and should have fairly good performance characteristics.
// The reasoning behind this is that it's only polling transport that will result in lots of sid misses in workers.
// Websocket connections are long lived so the hand-off to another worker only happens extremely infrequently.

var reqFields = ["httpVersion", "httpVersionMajor", "httpVersionMinor", "complete", "headers", "rawHeaders", "trailers", "rawTrailers", "url", "method", "_query"];

if (cluster.isMaster) {
  var numWorkers = os.cpus().length;
  numWorkers = 2;

  var sessionIds = {};
  var workerSessions = {};

  setInterval(function() {
    console.log(sessionIds);
  }, 1000);

  var pickRandomWorker = function() {
    var workerKeys = Object.keys(cluster.workers);
    return cluster.workers[workerKeys[Math.floor(Math.random()*workerKeys.length)]];
  };

  // TODO: handle worker death.

  var dispatchToWorker = function(worker, reqPayload, data, fd) {
    worker.send({type: "socketclusterer:conn", payload: reqPayload, data: data}, fd);
  };

  var workerMessageHandler = function(message, fd) {
    if (message && message.type) {
      debug("Master got message " + message.type);
      switch (message.type) {
        case "socketclusterer:reroute": {
          var reqPayload = message.payload;

          var sid = reqPayload._query.sid;
          if (!sid) {
            // Uh? Why were we given this at all?
            console.warn("Super weird: master was given socket.io connection to re-route, with no existing sid.");
            dispatchToWorker(pickRandomWorker(), reqPayload, message.data, fd);
            return;
          }

          var workerId = sessionIds[sid],
              worker;

          if (!workerId || !cluster.workers[workerId]) {
            dispatchToWorker(pickRandomWorker(), reqPayload, message.data, fd);
            return;
          }

          dispatchToWorker(cluster.workers[workerId], reqPayload, message.data, fd);

          break;
        }
        case "socketclusterer:newsid": {
          sessionIds[message.sid] = this.id;
          break;
        }
        case "socketclusterer:delsid": {
          delete sessionIds[message.sid];
          break;
        }
      }
    }
  };

  var forkWorker = function() {
    var worker = cluster.fork();
    worker.on("message", workerMessageHandler.bind(worker));
    return worker;
  }

  for (var i = 0; i < numWorkers; i++) {
    forkWorker();
  }

  cluster.on("exit", function(worker) {
    debug("Worker " + worker.id + " died.");
    forkWorker();
  });
} else {
  debug("Worker " + cluster.worker.id + " starting.");

  // TODO: this is potentially unsafe, as the master may not acknowledge the new
  // sid before another request for that sid comes in from the client. I think
  // that's highly unlikely though - IPC is going to be a lot lower latency than
  // another network socket, right? :)
  io.eio.on("connection", function(socket) {
    process.send({type: "socketclusterer:newsid", sid: socket.id});

    socket.on("close", function() {
      process.send({type: "socketclusterer:delsid", sid: socket.id});
    });
  });

  shimmer.wrap(io.eio, "handleRequest", function(original) {
    process.on("message", function(message, fd) {
      switch((message || {}).type) {
        case "socketclusterer:conn": {
          // Recreate req / res.
          var req = new http.IncomingMessage(fd);
          reqFields.forEach(function(field) {
            req[field] = message.payload[field];
          });

          var res = new http.ServerResponse(req);
          res.assignSocket(fd);

          http._connectionListener.call(server, fd);

          debug("(" + cluster.worker.id + ") was given a connection.", req.url);

          var socket = fd;

          // TODO: basically, we do this hacky shit where we got this connection
          // from another worker right? The problem is the internals of the
          // http server are all fucked up, so keep-alive connections are not
          // acting properly. I should try and fix this properly, but for now
          // we will simply nuke the connection once the response is complete.
          res.setHeader("Connection", "close");
          res.on("finish", function() {
            res.detachSocket(socket);
            socket.destroySoon();
          });

          original.call(io.eio, req, res);

          message.data.forEach(function(data) {
            debug("Emitting data.", new Buffer(data, "base64").toString());
            req.emit("data", new Buffer(data, "base64"));
          });
          req.emit("end");

          break;
        }
      }
    });

    return function(req, res) {
      debug("(" + cluster.worker.id + ") is passing off a connection", sid);

      var chunks = [];

      // This request already has an sid that we don't own. Send it to master
      // to be rerouted.

      var socket = req.connection;
      
      req.on("data", function(data) {
        chunks.push(data.toString("base64"));
      });

      req.on("end", function() {
        var reqPayload = {};
        reqFields.forEach(function(field) {
          reqPayload[field] = req[field];
        });
        process.send({type: "socketclusterer:reroute", payload: reqPayload, data: chunks}, socket);

        // Make sure we clean up the request from this worker, since we've now
        // passed it off to another one.
        socket.ondata = null;
        socket.onend = null;
        socket.removeAllListeners();

        var parser = socket.parser;
        if (parser) {
          parser.finish();
          socket.parser = null;
          parser._headers = [];
          parser.inIncoming = null;
          parser.socket = null;
          parser.incoming = null;
          http.parsers.free(parser);
        }
      });
    };
  });


  server.listen(3000);
}
