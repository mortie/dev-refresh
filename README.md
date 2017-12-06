# dev-refresh

`dev-refresh` is a utility to watch for changes in directories, and then run
your bundler or transpiler or have you, before refreshing your browser.

It supports both serving your local files (if you only need basic web server
functionality), and proxy requests to a web server if there's a server
component to your web application.

This program is not meant for production use; please only use it while
developing.

## Install

	npm install --save-dev dev-refresh

## Usage

Run `./node_modules/.bin/dev-refresh -h` for a list of arguments.

It will output this:

	Usage: dev-refresh [options] watch...
	Options:
	 -h, --help          Show this help text and exit
	 -c, --cmd <cmd>     Run <cmd> on change
	 -s, --serve <dir>   Serve files in <dir>
	 -p, --proxy <host>  Proxy requests to <host>
	     --port <port>   Serve on port <port>.
	     --host <host>   Serve from host <host>.

### Basic server

I recommend not running dev-refresh directly, but adding an npm script. For
example, to just serve the files in `public/` and automatically reload when
they change, put this in `package.json`:

	"scripts": {
		"watch": "./node_modules/.bin/dev-refresh public --serve public"
	}

Now, running `npm run watch` will create a server on `127.0.0.1:8080` which
serves the content of `public/`, and any time a file in the directory changes,
the browser will automatically reload.

### Transpiling

Let's say you're using babel with browserify to transpile modern javascript to
ES5. Let's say you want `npm run build-dev` to compile once, and `npm run
watch` to recompile and serve with dev-refresh. Put this in `package.json`:

	"scripts": {
		"watch": "./node_modules/.bin/dev-refresh --serve public --cmd 'npm run build-dev' js"
		"build-dev": "browserify js/main.js -t [ babelify --sourceMap ] --debug --outfile public/bundle.js",
	}

Now, `npm run watch` will automatically transpile and reload the browser
whenever anything in `js` changes.

### Proxy

If you have an application with a server side component, you might not want
dev-server to serve any static files, but might still want automatic
transpilation or reloading.

To start dev-refresh on port 8081, with a proxy to `localhost:8080`, and
running `npm run build-dev` any time anything in `js` or `sass` changes, run:

	dev-refresh --port 8081 --proxy 'localhost:8080' --cmd 'npm run build-dev' js sass
