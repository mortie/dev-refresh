#!/usr/bin/env node

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

function usage(code) {
	console.error("Usage: dev-refresh [options] watch...");
	console.error("Options:");
	console.error(" -h, --help          Show this help text and exit");
	console.error(" -c, --cmd <cmd>     Run <cmd> on change");
	console.error(" -s, --serve <dir>   Serve files in <dir>");
	console.error(" -p, --proxy <host>  Proxy requests to <host>");
	console.error("     --port <port>   Serve on port <port>.")
	console.error("     --host <host>   Serve from host <host>.");
	console.error(" -n                  Don't open the page in a browser.");
	process.exit(code);
}

let argv = parseArgs(process.argv.slice(2), {
	string: [ "w", "watch", "c", "cmd", "port", "host" ],
	boolean: [ "h", "help", "n" ],
});

let args = {
	watchdirs: argv._,
	help: argv.h || argv.help,
	cmd: argv.c || argv.cmd,
	serve: argv.s || argv.serve,
	proxy: argv.p || argv.proxy,
	port: argv.port,
	host: argv.host,
	noOpen: argv.n,
};

if (args.help) {
	usage(0);
}

if (args.serve && args.proxy) {
	console.error("Cannot serve and proxy at the same time.");
	process.exit(1);
}

let app = new webframe.App({
	port: args.port,
	host: args.host,
});


class Runner {
	constructor(cmd, cb) {
		this.cmd = cmd;
		this.cb = cb;
		this.updateNeeded = false;
		this.cmdRunning = false;
	}

	print(d) {
		d.toString().split("\n")
			.map(s => s.trim())
			.filter(s => s !== "")
			.forEach(s => console.log(s));
	}

	run() {
		if (!this.cmd)
			return this.cb();

		if (this.cmdRunning) {
			this.updateNeeded = true;
			return;
		}

		this.print("> "+this.cmd);

		this.cmdRunning = true;
		let child = exec(this.cmd);
		child.stdout.on("data", d => this.print(d));
		child.stderr.on("data", d => this.print(d));

		child.on("error", err => {
			app.warning("Running command failed: "+err.toString());
			this.cmdRunning = false;
		});

		child.on("exit", code => {
			this.cmdRunning = false;

			if (code !== 0) {
				if (code == null)
					app.warning("Command exited without an exit code.");
				else
					app.warning("Command exited with exit code "+code+".");
			}

			if (this.updateNeeded) {
				app.info(
					"Running update again because files have changed "+
					"since the child process started.");
				this.updateNeeded = false;
				this.run();
			} else {
				this.cb();
			}
		});
	}
}

let runner = new Runner(args.cmd, reload);

// Watch directory for changes
if (args.watchdirs.length > 0) {
	args.watchdirs.forEach(dir => {
		watch(dir, { recursive: true }, (evt, name) => {
			runner.run();
		});
	});
}

// Reload by ending all pending incoming connections
let pendingResponses = [];
let reloadId = "";
function reload() {
	app.info("Reloading.");
	reloadId = Math.floor(Math.random() * 1000000).toString();
	pendingResponses.forEach(res => res.end());
	pendingResponses.length = 0;
}

// Inject reload script into HTML files
let clientHtml = fs.readFileSync(__dirname+"/client.html", "utf-8");
function injectHtml(str, stream) {
	let rx = /<\s*\/\s*body\s*>/ig;

	// Don't modify anything if we're not
	// listening for changes in a directory
	if (args.watchdirs.length === 0)
		return stream.end(str);

	// Find </body>
	let matches = str.match(rx);
	if (matches == null || matches.length === 0) {
		app.warning("Found no body close tag in '"+path+"'.");
		return stream.end(str);
	}

	// Replace {{reloadId}} with the actual ID
	let inject = clientHtml.replace("{{reloadId}}", reloadId);

	// Extract code after and before the </body> tag
	let match = matches[matches.length - 1];
	let idx = str.lastIndexOf(match);
	let before = str.slice(0, idx);
	let after = str.slice(idx + match.length);

	stream.write(before);
	stream.write(inject);
	stream.end(after);
}

// For long polling
app.get("/__dev-refresh-poll", (req, res) => {
	let q = req.url.split("?")[1];
	if (!q) return res.end();
	if (q !== reloadId) return res.end();
	pendingResponses.push(res);
});

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
if (!args.noOpen && (args.serve || args.proxy)) {
	open("http://"+app.host+":"+app.port);
}
