"use strict";

var ioClient = require("socket.io-client"),
    cluster = require("cluster"),
    socketIo = require("socket.io");

socketIo = require("../socketio-cluster")(socketIo);

var http = require("http");
var foo = http.createClient;
http.createClient = function() {
  console.log("Creating client.");
  return foo.apply(this,arguments);
};

var expect = require("chai").expect;

describe("socket.io-cluster", function() {
  this.timeout(60000);  // 60 seconds.

  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker.js"
    });
  });

  function spawnClient(address, transports) {
    var client = ioClient(address, { multiplex: false, transports: transports });

    client.on("connect", function() {
      client._savedMessages = [];
      client.on("ping", function(message) {
        client._savedMessages.push(message);

        if (client._savedMessages.length === 10) {
          client.disconnect();
        }
      });
    }.bind(client));

    return client;
  }

  it("behaves correctly under high load - polling transport", function(done) {
    var numWorkers = Math.max(2, require("os").cpus().length);
    var workers = [];
    for(var i = 0; i < numWorkers; i++) {
      workers.push(cluster.fork());
    }

    // var numWorkersReady = 0;
    // cluster.on("listening", function(worker, address) {
      // numWorkersReady++;
      // if (numWorkersReady < numWorkers) {
      //   return;
      // }

      var numClients = 50;
      var numCreated = 0;
      var numConnected = 0;
      var spawnedClients = [];
      var address = "http://localhost:3000";// + address.port;

      var clientConnectHandler = function() {
        numConnected++;
      };

      var clientDisconnectHandler = function(reason) {
        console.log("DC:", reason);
        numConnected--;

        expect(this._savedMessages).to.have.length(10);

        // Make sure all messages originated from same worker.
        var worker;
        this._savedMessages.forEach(function(message) {
          if (!worker) worker = message.worker;

          expect(message.worker).to.equal(worker);
        });

        if (numConnected === 0) {
          done();
        }
      }

      setInterval(function() {
        console.log(spawnedClients.length);
      }, 500);

      var createInterval = setInterval(function() {
        if (numCreated === numClients) {
          clearInterval(createInterval);
          return;
        }
        numCreated++;

        var client = spawnClient(address, ["polling"]);
        client.on("connect", clientConnectHandler.bind(client));
        client.on("disconnect", clientDisconnectHandler.bind(client));
        spawnedClients.push(client);
      }, 1);
    // });
  });
});
