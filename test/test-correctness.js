"use strict";

var ioClient = require("socket.io-client"),
    cluster = require("cluster"),
    socketIo = require("socket.io");

socketIo = require("../socketio-cluster")(socketIo);

var expect = require("chai").expect;

describe("socket.io-cluster", function() {
  this.timeout(60000);  // 60 seconds.

  var numPackets = 10;
  var numWorkers = 4;
  var numClients = 10;

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

        if (client._savedMessages.length === numPackets) {
          client.disconnect();
        }
      });
    }.bind(client));

    return client;
  }

  // Socket.io polling transport has issues with a high number of connections
  // atm. This test breaks with more than 100 clients.
  it("behaves correctly under high load - polling transport", function(done) {
    var workers = [];
    for(var i = 0; i < numWorkers; i++) {
      var worker = cluster.fork();
      worker.on("exit", function(code) {
        // Workers should only die normally.
        expect(code).to.eql(0);
      });
      workers.push(worker);
    }

    var numWorkersReady = 0;
    cluster.on("listening", function(worker, address) {
      numWorkersReady++;
      if (numWorkersReady < numWorkers) {
        return;
      }

      var numCreated = 0;
      var numConnected = 0;
      var spawnedClients = [];

      var clientConnectHandler = function() {
        numConnected++;
      };

      var clientDisconnectHandler = function(reason) {
        numConnected--;

        expect(this._savedMessages).to.have.length(numPackets);

        // Make sure all messages originated from same worker.
        var worker;
        this._savedMessages.forEach(function(message) {
          if (!worker) worker = message.worker;

          expect(message.worker).to.equal(worker);
        });

        if (numConnected === 0) {
          done();
        }
      };

      setInterval(function() {
        console.log(spawnedClients.length);
      }, 500);

      var createInterval = setInterval(function() {
        if (numCreated === numClients) {
          clearInterval(createInterval);
          return;
        }
        numCreated++;

        var client = spawnClient("http://localhost:" + address.port, ["polling"]);
        client.on("connect", clientConnectHandler.bind(client));
        client.on("disconnect", clientDisconnectHandler.bind(client));
        spawnedClients.push(client);
      }, 1);
    });
  });

  it.only("behaves correctly under high load - websocket transport", function(done) {
    var workers = [];
    for(var i = 0; i < numWorkers; i++) {
      var worker = cluster.fork();
      worker.on("exit", function(code) {
        // Workers should only die normally.
        expect(code).to.eql(0);
      });
      workers.push(worker);
    }

    var numWorkersReady = 0;
    cluster.on("listening", function(worker, address) {
      numWorkersReady++;
      if (numWorkersReady < numWorkers) {
        return;
      }

      var numCreated = 0;
      var numConnected = 0;
      var spawnedClients = [];

      var clientConnectHandler = function() {
        numConnected++;
      };

      var clientDisconnectHandler = function() {
        numConnected--;

        expect(this._savedMessages).to.have.length(numPackets);

        // Make sure all messages originated from same worker.
        var worker;
        this._savedMessages.forEach(function(message) {
          if (!worker) worker = message.worker;

          expect(message.worker).to.equal(worker);
        });

        if (numConnected === 0) {
          done();
        }
      };

      setInterval(function() {
        // console.log(spawnedClients[0]);
        // console.log(spawnedClients[0].io.engine.transport.ws._socket.destroy());
      }, 1000);

      var createInterval = setInterval(function() {
        if (numCreated === numClients) {
          clearInterval(createInterval);
          return;
        }
        numCreated++;

        var client = spawnClient("http://localhost:" + address.port);
        client.on("connect", clientConnectHandler.bind(client));
        client.on("disconnect", clientDisconnectHandler.bind(client));
        spawnedClients.push(client);
      }, 1);
    });
  });
});
