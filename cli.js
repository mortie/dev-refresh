#!/usr/bin/env node

let WebSocket = require("ws");
let colors = require("colors");
let webframe = require("webframe");
let watch = require("node-watch");
let parseArgs = require("minimist");
let exec = require("child_process").exec;
let fs = require("fs");
let pathlib = require("path");
let urllib = require("url");
let http = require("http");
let https = require("https");
let open = require("open");

function debounce(func, time, ...args) {
	let to = null;

	return function() {
		if (to != null) {
			clearTimeout(to);
			to = null;
		}

		to = setTimeout(func, time, ...args);
	}
}

function log(str) {
	console.error(str);
}

function usage(code) {
	console.error("Usage: dev-refresh [options] watch...");
	console.error("Options:");
	console.error(" -h, --help          Show this help text and exit");
	console.error(" -c, --cmd <cmd>     Run <cmd> on change");
	console.error(" -s, --serve <dir>   Serve files in <dir>");
	console.error(" -p, --proxy <host>  Proxy requests to <host>");
	console.error("     --port <port>   Serve on port <port>.")
	console.error("     --host <host>   Serve from host <host>.");
	console.error(" -n  --no-open       Don't open the page in a browser.");
	process.exit(code);
}

let args = parseArgs(process.argv.slice(2), {
	alias: {
		h: "help",
		c: "cmd",
		s: "serve",
		p: "proxy",
	},
	string: [ "serve", "cmd", "port", "host" ],
	boolean: [ "help", "open", "n" ],
	default: { open: true }
});

args.open = args.open && !args.n;

if (args.help) {
	usage(0);
}

if (args.serve && args.proxy) {
	console.error("Cannot serve and proxy at the same time.");
	process.exit(1);
}

if (process.argv.length === 2) {
	usage(1);
}

class Runner {
	constructor(cmd, cb) {
		this.cmd = cmd;
		this.cb = cb;
		this.updateNeeded = false;
		this.output = "";
		this.child = null;
	}

	onOutput(d) {
		process.stderr.write(d.toString().blue);
		this.output += d;
	}

	run() {
		if (!this.cmd)
			return this.cb();

		if (this.child) {
			this.updateNeeded = true;
			log("Killing child process because something changed.");
			this.child.kill("SIGTERM");
			return;
		}

		log(("> "+this.cmd).green);

		this.child = exec(this.cmd);
		this.output = "";
		this.child.stdout.on("data", d => this.onOutput(d));
		this.child.stderr.on("data", d => this.onOutput(d));

		this.child.once("error", err => {
			log("Warning: Running command failed: "+err.toString());
			this.child = null;
		});

		this.child.once("exit", (code, sig) => {
			this.child = null;

			if (code !== 0) {
				if (sig != null)
					log("Command exited due to "+sig+".");
				else
					log("Command exited with exit code "+code+".");
			}

			if (this.updateNeeded) {
				this.updateNeeded = false;
				this.run();
			} else {
				this.cb(code, this.output);
			}
		});
	}
}

let runner = new Runner(args.cmd, reload);

// Watch directory for changes
if (args._.length > 0) {
	let watchCB = debounce(() => {
		runner.run();
	}, 100);

	args._.forEach(dir => {
		watch(dir, {
			recursive: true,
			filter: x => !/(^|\/)(node_modules|.git)(\/|$)/.test(x)
		}, watchCB);
	});
}

function randId() {
	return Math.floor(Math.random() * 1000000000 + 1).toString();
}

// Reload by ending all pending incoming connections
let pendingResponses = [];
let reloadId = randId();
let reloadResponse = JSON.stringify({ reload: false, reloadId: reloadId });
function reload(code, output) {
	let reload;
	if (code === 0 || code == null) {
		reload = true;
		log("Reloading.\n");
	} else {
		reload = false;
		log("Not reloading.\n");
	}

	reloadId = randId();
	let obj = {
		reload,
		code,
		output,
		reloadId,
		command: runner.cmd,
	};
	let json = JSON.stringify(obj);

	pendingResponses.forEach(res => res.end(json));
	pendingResponses.length = 0;

	// We don't want to respond with 'reload: true' to new clients
	obj.reload = false;
	reloadResponse = JSON.stringify(obj);
}

// Inject reload script into HTML files
let clientHtml = fs.readFileSync(__dirname+"/client.html", "utf-8");
function injectHtml(str, stream) {
	let rx = /<\s*\/\s*body\s*>/ig;

	// Don't modify anything if we're not
	// listening for changes in a directory
	if (args._.length === 0)
		return stream.end(str);

	// Find </body>
	let matches = str.match(rx);
	if (matches == null || matches.length === 0) {
		log("Warning: Found no body close tag in '"+path+"'.");
		return stream.end(str);
	}

	// Extract code after and before the </body> tag
	let match = matches[matches.length - 1];
	let idx = str.lastIndexOf(match);
	let before = str.slice(0, idx);
	let after = str.slice(idx + match.length);

	stream.write(before);
	stream.write(clientHtml);
	stream.end(after);
}

// Create webframe instance if we need an HTTP server
let app;
if (args.serve || args.proxy) {
	app = new webframe.App({
		port: args.port,
		host: args.host,
	});

	// For long polling
	app.get("/__dev-refresh-poll", (req, res) => {
		let q = req.url.split("?")[1];

		if (!q)
			return res.end(reloadResponse);
		if (q !== reloadId)
			return res.end(reloadResponse);

		// Otherwise, add it to our list of pending responses for long polling
		pendingResponses.push(res);
	});
}

// Serve static files
if (args.serve) {
	function transform(path, stream) {
		fs.readFile(path, "utf-8", (err, str) => {
			if (err)
				return stream.error(err);

			injectHtml(str, stream);
		});
	}

	// Add transform to .html and .htm files
	app.transform(".html", "text/html", transform);
	app.transform(".htm", "text/html", transform);

	// Serve static files
	app.get("^.*", webframe.static(args.serve));
}

// Proxy
if (args.proxy) {
	if (!args.proxy.includes("://"))
		args.proxy = "http://"+args.proxy

	function proxy(oreq, ores) {
		let opts = urllib.parse(args.proxy);
		opts.headers = oreq.headers;
		opts.headers.host = opts.host;

		let reqUrl = urllib.parse(oreq.url);
		opts.hash = reqUrl.hash;
		opts.search = reqUrl.search;
		opts.query = reqUrl.query;
		opts.pathname = reqUrl.pathname;
		opts.path = reqUrl.path;

		// Disable caching and compression
		delete opts.headers["if-modified-since"];
		delete opts.headers["if-none-match"];
		delete opts.headers["accept-encoding"];

		// Choose http/https based on protocol
		let obj = opts.protocol === "https:" ? https : http;

		// Send request
		let req = obj.request(opts, res => {

			// Just pipe if not text/html
			if (res.headers["content-type"] !== "text/html") {
				ores.writeHead(res.statusCode, res.headers);
				return res.pipe(ores);
			}

			// Remove content-length, because we'll modify the content.
			// Tell the client to not cache anything.
			delete res.headers["content-length"];
			res.headers["cache-control"] =
				"max-age=0, no-cache, must-revalidate, proxy-revalidate";
			ores.writeHead(res.statusCode, res.headers);

			// Soak up response string, then inject client HTML
			let str = "";
			res.on("data", d => str += d);
			res.on("end", () => {
				injectHtml(str, ores);
			});
		});
		req.once("error", err => {
			console.error("Failed to send request to "+urllib.format(opts)+":", err.code);
			ores.writeHead(502);
			ores.end("502 Bad Gateway");
		});
		req.end();
	}

	app.all("^.*", (req, res) => {
		proxy(req, res);
	});

	let wss = null;
	app.server.on("upgrade", (oreq, osock, head) => {
		if (wss == null)
			wss = new WebSocket.Server({ noServer: true });

		let opts = urllib.parse(args.proxy);

		let s1 = {
			open: false,
			queue: [],
			sock: null,
		};

		let s2 = {
			open: false,
			queue: [],
			sock: null,
		};

		s1.sock = new WebSocket(
			`${opts.protocol == "http:" ? "ws:" : "wss:"}//${opts.host}${oreq.url}`);
		s1.sock.once("error", err => {
			console.error("Proxy sock error:", err.code);
		});
		s1.sock.once("open", () => {
			s1.open = true;
			for (let i = 0; i < s1.queue.length; ++i)
				s1.sock.send(s1.queue[i]);
			s1.queue = [];
		});
		s1.sock.once("close", () => {
			s1.sock = null;
			if (s2.sock)
				s2.sock.close();
		});
		s1.sock.on("message", msg => {
			if (s2.sock && s2.open)
				s2.sock.send(msg);
			else if (s2.sock)
				s2.queue.push(msg);
		});

		wss.handleUpgrade(oreq, osock, head, sock => {

			// If s1 closed, do nothing
			if (s1.open && !s1.sock) {
				s2.sock.close();
				s2.sock = null;
				return;
			}

			s2.sock = sock;

			s2.sock.once("error", err => {
				console.error("Proxy sock error:", err.code);
			});

			s2.open = true;
			for (let i = 0; i < s2.queue.length; ++i)
				s2.sock.send(s2.queue[i]);
			s2.queue = [];

			s2.sock.once("close", () => {
				s2.sock = null;
				if (s1.sock)
					s1.sock.close();
			});
			s2.sock.on("message", msg => {
				if (s1.sock && s1.open)
					s1.sock.send(msg);
				else if (s1.sock)
					s1.queue.push(msg);
			});
		});
	});
}

// Run command once immediately
runner.run();

// Open in browser
if (args.open && (args.serve || args.proxy)) {
	open("http://"+app.host+":"+app.port);
}
