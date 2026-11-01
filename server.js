"use strict";

// Tiny bridge: serves the web page and runs the compiled C++ program for every request.
// No npm packages needed.
//
//   1. g++ -std=c++17 -O2 -o metro main.cpp      (Windows: -o metro.exe)
//   2. node server.js
//   3. open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const BINARY = path.join(__dirname, process.platform === "win32" ? "metro.exe" : "metro");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
};

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// Arguments go in an array (no shell), so request values can't inject commands.
function runCpp(args, res) {
    if (!fs.existsSync(BINARY)) {
        sendJson(res, 500, { error: "C++ program not found. Compile main.cpp first (see top of server.js)." });
        return;
    }
    execFile(BINARY, args, { cwd: __dirname, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) {
            sendJson(res, 500, { error: "C++ program failed." });
            return;
        }
        sendJson(res, 200, stdout.trim());
    });
}

function serveStatic(urlPath, res) {
    const requested = urlPath === "/" ? "/index.html" : urlPath;
    const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
    });
}

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const OFF_PATTERN = /^[A-Z0-9,]{0,60}$/;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/network") {
        runCpp(["--network"], res);
    } else if (url.pathname === "/api/route") {
        const start = url.searchParams.get("start") || "";
        const dest = url.searchParams.get("dest") || "";
        const off = url.searchParams.get("off") || "";

        if (!ID_PATTERN.test(start) || !ID_PATTERN.test(dest) || !OFF_PATTERN.test(off)) {
            sendJson(res, 400, { found: false, error: "Bad request." });
            return;
        }
        const args = ["--route", start, dest];
        if (off) args.push(off);
        runCpp(args, res);
    } else {
        serveStatic(url.pathname, res);
    }
});

server.listen(PORT, () => {
    console.log(`Metro Path Finder running at http://localhost:${PORT}`);
});
