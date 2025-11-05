const http = require("http");
const fs = require("fs");
const path = require("path");

const UI_ROOT = path.resolve(__dirname, "..", "ui");
const PORT = Number(process.env.UI_PORT || 4000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[ui-server ${timestamp}] ${message}`);
}

function resolveFile(requestPath) {
  const requested = requestPath.split("?")[0].split("#")[0];
  const target =
    requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const normalized = path.normalize(target);
  if (normalized.includes("..")) return null;
  const absolute = path.join(UI_ROOT, normalized);
  if (!absolute.startsWith(UI_ROOT)) return null;
  return absolute;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const filePath = resolveFile(req.url || "/");
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", (streamErr) => {
      log(`Stream error for ${filePath}: ${streamErr.message}`);
      res.destroy(streamErr);
    });
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  log(`Serving UI from ${UI_ROOT}`);
  log(`Open http://localhost:${PORT} in the browser.`);
});
