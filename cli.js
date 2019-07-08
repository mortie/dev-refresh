#!/usr/bin/env node

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

	print(d) {
		d.toString().split("\n")
			.map(s => s.trim())
			.filter(s => s !== "")
			.forEach(s => log(s));
	}

	onOutput(d) {
		this.print(d.blue);
		this.output += d;
	}

	run() {
		if (!this.cmd)
			return this.cb();

		if (this.child) {
			this.updateNeeded = true;
			this.print("Killing child process because something changed.");
			this.child.kill("SIGTERM");
			return;
		}

		this.print(("> "+this.cmd).green);

		this.child = exec(this.cmd);
		this.output = "";
		this.child.stdout.on("data", d => this.onOutput(d));
		this.child.stderr.on("data", d => this.onOutput(d));

		this.child.on("error", err => {
			log("Warning: Running command failed: "+err.toString());
			this.child = null;
		});

		this.child.on("exit", (code, sig) => {
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
	args._.forEach(dir => {
		watch(dir, {
			recursive: true,
			filter: x => !/^\.git$/.test(x)
		}, (evt, name) => {
			runner.run();
		});
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
	if (code === 0 || code == null)
		log("Reloading.\n");
	else
		log("Not reloading.\n");

	reloadId = randId();
	let obj = {
		reload: code === 0,
		reloadId: reloadId,
		command: runner.cmd,
		code: code,
		error: code === 0 ? null : output,
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
		req.end();
	}

	app.all("^.*", (req, res) => {
		proxy(req, res);
	});
}

// Run command once immediately
runner.run();

// Open in browser
if (args.open && (args.serve || args.proxy)) {
	open("http://"+app.host+":"+app.port);
}
