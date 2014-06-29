var net = require("net");


var socket = net.createConnection({port: 3000, host: "localhost"});

socket.on("connect", function() {
    socket.write("PUT / HTTP/1.1\r\nContent-Length: 10\r\n\r\n1");

    socket.write("2");
    socket.write("3");
    socket.write("4");
    socket.write("5");

    setTimeout(function() {
        console.log("Written moar.");
        socket.write("67890");
        socket.end();
    }, 1000);
});