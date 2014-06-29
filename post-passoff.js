var cluster = require("cluster");
var http = require("http");
var server = http.createServer();
var chunked = require("chunked");
// var server = require("net").createServer();

if(cluster.isMaster) {
    var worker = cluster.fork();

    worker.on("message", function(msg, socket) {
        console.log("Master got connection.");

        socket.on("data", function(data) {
            console.log("master got data!", data.length);
        });

        socket.resume();
    });
} else {
    server.on("request", function(req, res) {
        setTimeout(res.end.bind(res), 1000);

        var socket = req.connection;

        Object.keys(socket._events).forEach(function(ev) {
            socket.removeAllListeners(ev);
        });

        socket.ondata = null;
        socket.onend = null;

        req.connection.parser.onBody = function(buf, start, len) {
            var foo = buf.slice(start, start+len);

            console.log("caught", foo.length);
        }

        setImmediate(function() {
            console.log("bar.");
        });


        // socket.parser.socket = null;
        // socket.parser.incoming = null;
        // socket.parser.onIncoming = null;
        // http.parsers.free(socket.parser);
        // socket.parser = null;

        socket.on("data", function(data) {
            // console.log("raw read.", data.toString());
        });

        // req.pause();

        // req.on("data", function() { console.log(arguments); });
        // req.on("end", function() {
        //     console.log("fin.");
        //     res.end();
        // })
        // req.on("end", res.end.bind(res));
        // res.end();
        return;

        // req.connection.pause();
        // req.connection.parser.pause();

        // console.log("parser?", req.connection);

        // req.pause();
        // setTimeout(function() {
        //     console.log("hm.");
        //     req.on("data", function(data) {
        //         console.log("Worker got data ;(", data.length);
        //     });
        //     // req.resume();
        // }, 1000);

        // req.connection.parser.pause();




        socket.on("end", function() {
            console.log("okay.");
        });

        // req.connection.resume();

        // process.send("yay!", req.connection);
        // process.send("yay!", req);

    });

    server.listen(3000);
}
