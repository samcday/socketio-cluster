var http = require("http"),
    socketIo = require("socket.io"),
    cluster = require("cluster");

socketIo = require("../socketio-cluster")(socketIo);

var server = http.createServer();
server.listen(3000);

var io = socketIo(server);

server.on("listening", function() {
  io.on("connection", function(socket) {
    // console.log("Connection.");
  });

  setInterval(function() {
    io.emit("ping", {worker: cluster.worker.id, date: Date.now()});
  }, 1000);
});
