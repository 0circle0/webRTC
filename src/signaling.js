const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./auth");
const url = require("url");
const { createSignalingContext } = require("./signaling/context");
const { registerSfuEvents } = require("./signaling/events");
const { createMessageRouter } = require("./signaling/router");

function createSignalingServer(wss, sfu) {
  const context = createSignalingContext({ sfu });
  registerSfuEvents(context);
  const routeMessage = createMessageRouter(context);

  function send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.warn("Failed to send message", err.message);
    }
  }

  const isAuthRequired = () => context.config.requireAuth;

  wss.on("connection", (ws, req) => {
    const clientId = uuidv4();
    const parsed = url.parse(req.url || "", true);
    const token = parsed.query && parsed.query.token;
    const user = validateToken(token);

    if (isAuthRequired() && !user) {
      console.log("unauthorized connection - closing");
      send(ws, { type: "error", message: "unauthorized" });
      ws.close();
      return;
    }

    context.addClient(clientId, ws, user);
    console.log("Client connected:", clientId, "user:", user && user.id);
    send(ws, { type: "id", id: clientId });

    ws.on("message", async (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      if (raw.length) {
        console.log(`raw from ${clientId}:`, raw);
      } else {
        console.log(`raw from ${clientId}: <non-text>`);
      }

      await routeMessage(clientId, ws, data);
    });

    ws.on("close", async () => {
      await context.removeClientFromAllRooms(clientId);
      await context.closeClientResources(clientId);
      if (sfu && sfu.closeClient) {
        try {
          sfu.closeClient(clientId);
        } catch (err) {
          console.warn("failed to close SFU state for client", err.message);
        }
      }
      context.removeClient(clientId);
      console.log("Client disconnected:", clientId);
      for (const [id, other] of context.clients.entries()) {
        if (id === clientId || !other.ws) continue;
        send(other.ws, { type: "leave", id: clientId });
      }
    });

    ws.on("error", (err) => {
      console.error("ws error", err);
    });
  });

  function getRooms() {
    return context.getRoomsOverview().map(({ name, count }) => ({
      name,
      count,
    }));
  }

  function getRoomInfo(name) {
    return context.getRoomInfo(name);
  }

  return { getRooms, getRoomInfo };
}

module.exports = { createSignalingServer };
