const WebSocket = require("ws");
const { createSignalingServer } = require("./signaling");
const { createSFUServer } = require("./sfu");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebRTC signaling server starting on ws://0.0.0.0:${PORT}`);

// start SFU and pass to signaling so signaling can call SFU helpers
let sfu;
try {
  sfu = createSFUServer();
} catch (err) {
  console.error("SFU initialization failed, exiting");
  process.exit(1);
}

if (!sfu) {
  console.error("SFU not available. Server requires mediasoup.");
  process.exit(1);
}

sfu.createWorkers().catch((err) => {
  console.error("Failed to start SFU workers", err);
  process.exit(1);
});

const signalingAdmin = createSignalingServer(wss, sfu);

// small HTTP admin server
const http = require("http");
const adminPort =
  process.env.ADMIN_PORT ||
  (process.env.PORT ? String(Number(process.env.PORT) + 1) : 3001);
const adminServer = http.createServer((req, res) => {
  // simple auth: token via ?token= or Authorization: Bearer <token>
  const url = require("url");
  const parsed = url.parse(req.url, true);
  const token = parsed.query && parsed.query.token;
  const authHeader = req.headers["authorization"];
  let bearer = null;
  if (!token && authHeader && authHeader.startsWith("Bearer "))
    bearer = authHeader.slice(7).trim();
  const adminToken = token || bearer;

  const { validateToken } = require("./auth");
  const user = validateToken(adminToken);
  if (!user || user.role !== "admin") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "admin token required" }));
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/admin/rooms") {
    const rooms = signalingAdmin.getRooms();
    const sfuRooms = sfu && sfu.getRoomsOverview ? sfu.getRoomsOverview() : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rooms, sfuRooms }));
    return;
  }

  const roomMatch =
    parsed.pathname && parsed.pathname.startsWith("/admin/room/");
  if (req.method === "GET" && roomMatch) {
    const name = parsed.pathname.replace("/admin/room/", "");
    const info = signalingAdmin.getRoomInfo(name);
    if (!info) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "room not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info));
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/admin/metrics") {
    const metrics = sfu && sfu.getMetrics ? sfu.getMetrics() : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ metrics }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

adminServer.listen(adminPort, () =>
  console.log(`Admin HTTP server listening on http://0.0.0.0:${adminPort}`)
);
