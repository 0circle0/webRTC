const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./auth");
const url = require("url");
const { getRoomDefaults, getIceServers } = require("./config");

function createSignalingServer(wss, sfu) {
  // Map of clientId -> { ws, user, role, transports:Set, producers:Set, consumers:Set, rooms:Set }
  const clients = new Map();
  // Map of roomName -> room state
  const rooms = new Map();

  function send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.error("Failed to send message", err);
    }
  }

  function ensureRoom(name) {
    if (!rooms.has(name)) {
      rooms.set(name, {
        members: new Set(),
        memberRoles: new Map(),
        producers: new Map(),
        observers: new Set(),
        options: getRoomDefaults(),
        ownerId: null,
        moderators: new Set(),
      });
    }
    return rooms.get(name);
  }

  function roomProducersPayload(roomObj) {
    if (!roomObj || !roomObj.producers) return [];
    return Array.from(roomObj.producers.entries()).map(
      ([producerId, info]) => ({
        producerId,
        kind: info.kind,
        clientId: info.clientId,
      })
    );
  }

  function closeClientProducersInRoom(roomObj, clientId) {
    if (!roomObj || !roomObj.producers) return;
    const toClose = [];
    for (const [producerId, info] of roomObj.producers.entries()) {
      if (info.clientId === clientId) toClose.push(producerId);
    }
    for (const producerId of toClose) {
      if (sfu && sfu.closeProducer) {
        sfu.closeProducer(producerId).catch(() => {});
      } else {
        roomObj.producers.delete(producerId);
      }
    }
  }

  function removeMemberFromRoom(roomObj, clientId) {
    roomObj.members.delete(clientId);
    roomObj.memberRoles.delete(clientId);
    roomObj.observers.delete(clientId);
    if (roomObj.ownerId === clientId) {
      roomObj.ownerId = null;
      for (const [memberId, role] of roomObj.memberRoles.entries()) {
        if (role === "publisher" || role === "moderator") {
          roomObj.ownerId = memberId;
          break;
        }
      }
    }
    if (roomObj.moderators.has(clientId)) roomObj.moderators.delete(clientId);
  }

  const REQUIRE_AUTH = process.env.ENABLE_AUTH == 1;

  if (sfu) {
    sfu.on("transport-closed", ({ clientId, transportId }) => {
      const clientObj = clients.get(clientId);
      if (clientObj && clientObj.transports)
        clientObj.transports.delete(transportId);
      if (clientObj && clientObj.transportInfo)
        clientObj.transportInfo.delete(transportId);
    });

    sfu.on("producer-closed", ({ producerId, roomName, clientId }) => {
      const clientObj = clients.get(clientId);
      if (clientObj && clientObj.producers)
        clientObj.producers.delete(producerId);
      const roomObj = rooms.get(roomName);
      if (!roomObj || !roomObj.producers) return;
      if (!roomObj.producers.has(producerId)) return;
      roomObj.producers.delete(producerId);
      for (const memberId of roomObj.members) {
        const memberObj = clients.get(memberId);
        if (memberObj && memberObj.ws)
          send(memberObj.ws, {
            type: "sfu.producerClosed",
            room: roomName,
            producerId,
            clientId,
          });
      }
    });

    sfu.on("consumer-closed", ({ clientId, consumerId }) => {
      const clientObj = clients.get(clientId);
      if (clientObj && clientObj.consumers)
        clientObj.consumers.delete(consumerId);
    });
  }

  async function handleMessage(ws, clientId, data) {
    try {
      const raw = data.toString();
      console.log(`raw from ${clientId}: ${raw}`);
    } catch (e) {
      console.log(`raw from ${clientId}: <non-text>`);
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.warn("Invalid JSON from", clientId);
      return;
    }
    console.log("parsed from", clientId, {
      type: msg.type,
      room: msg.room,
      to: msg.to,
    });

    const { type, to, room } = msg;

    // helper to send error
    const sendError = (m) => send(ws, { type: "error", message: m });

    switch (type) {
      // --- SFU related messages (if sfu provided) ---
      case "sfu.createTransport": {
        if (!sfu) return sendError("sfu not enabled on server");
        const { direction = "send", room: targetRoom } = msg;
        if (!targetRoom)
          return sendError("room required when creating transport");
        try {
          const {
            transportId,
            iceParameters,
            iceCandidates,
            dtlsParameters,
            routerRtpCapabilities,
            direction: actualDirection,
          } = await sfu.createWebRtcTransport({
            roomName: targetRoom,
            clientId,
            direction,
          });
          const clientObj = clients.get(clientId);
          clientObj.transports.add(transportId);
          clientObj.transportInfo = clientObj.transportInfo || new Map();
          clientObj.transportInfo.set(transportId, {
            room: targetRoom,
            direction: actualDirection,
          });
          send(ws, {
            type: "sfu.transportCreated",
            transportId,
            iceParameters,
            iceCandidates,
            dtlsParameters,
            iceServers: getIceServers(),
            direction: actualDirection,
            routerRtpCapabilities,
            requestId: msg.requestId || null,
          });
        } catch (err) {
          console.error("sfu.createTransport failed", err);
          sendError("sfu.createTransport failed");
        }
        return;
      }

      case "sfu.connectTransport": {
        if (!sfu) return sendError("sfu not enabled on server");
        const { transportId, dtlsParameters } = msg;
        if (!transportId || !dtlsParameters)
          return sendError("transportId and dtlsParameters required");
        const clientObj = clients.get(clientId);
        if (!clientObj.transports.has(transportId))
          return sendError("transport not found");
        try {
          await sfu.connectTransport({ transportId, dtlsParameters });
          send(ws, {
            type: "sfu.transportConnected",
            transportId,
            requestId: msg.requestId || null,
          });
        } catch (err) {
          console.error("sfu.connectTransport failed", err);
          sendError("sfu.connectTransport failed");
        }
        return;
      }

      case "ice": {
        // generic ICE candidate forwarding: { type: 'ice', to?, room?, candidate }
        const { candidate } = msg;
        if (!candidate) return sendError("candidate required");
        if (to) {
          const target = clients.get(to);
          if (target && target.ws)
            send(target.ws, { type: "ice", from: clientId, candidate });
          else sendError("target not found");
        } else if (room) {
          const roomObj = rooms.get(room);
          if (!roomObj) return sendError("room not found");
          for (const memberId of roomObj.members) {
            if (memberId === clientId) continue;
            const memberObj = clients.get(memberId);
            if (memberObj && memberObj.ws)
              send(memberObj.ws, { type: "ice", from: clientId, candidate });
          }
        } else {
          sendError("to or room required for ice");
        }
        return;
      }

      case "sfu.produce": {
        if (!sfu) return sendError("sfu not enabled on server");
        const { transportId, kind, rtpParameters, room: produceRoom } = msg;
        if (!transportId || !kind || !rtpParameters)
          return sendError("transportId, kind and rtpParameters required");
        // enforce room for producers
        if (!produceRoom) return sendError("room required when producing");
        const clientObj = clients.get(clientId);
        // observers cannot produce
        if (clientObj.role === "observer")
          return sendError("observers cannot produce");

        if (!clientObj.transports.has(transportId))
          return sendError("transport not found");

        // enforce room-level maxVideoProducers if configured (default 0 = unlimited)
        const roomObj = rooms.get(produceRoom);
        if (!roomObj) return sendError("room not found");
        const maxVideo =
          roomObj &&
          roomObj.options &&
          typeof roomObj.options.maxVideoProducers === "number"
            ? roomObj.options.maxVideoProducers
            : 0;
        if (kind === "video" && maxVideo > 0) {
          const videoCount = Array.from(roomObj.producers.values()).filter(
            (info) => info.kind === "video"
          ).length;
          if (videoCount >= maxVideo)
            return sendError(`room already has ${maxVideo} video producers`);
        }

        try {
          const { producerId } = await sfu.createProducer({
            transportId,
            roomName: produceRoom,
            clientId,
            kind,
            rtpParameters,
          });
          clientObj.producers.add(producerId);
          roomObj.producers.set(producerId, {
            clientId,
            kind,
            createdAt: Date.now(),
          });
          send(ws, {
            type: "sfu.produced",
            producerId,
            kind,
            requestId: msg.requestId || null,
          });

          // Notify room members a new producer is available if client is in a room
          const roomView = rooms.get(produceRoom);
          if (roomView) {
            for (const memberId of roomView.members) {
              if (memberId === clientId) continue;
              const memberObj = clients.get(memberId);
              if (memberObj && memberObj.ws)
                send(memberObj.ws, {
                  type: "sfu.newProducer",
                  room: produceRoom,
                  producerId,
                  clientId,
                  producerUser: clientObj.user && clientObj.user.id,
                  kind,
                });
            }
          }
        } catch (err) {
          console.error("sfu.produce failed", err);
          sendError("sfu.produce failed");
        }
        return;
      }

      case "sfu.consume": {
        if (!sfu) return sendError("sfu not enabled on server");
        const {
          transportId,
          producerId,
          rtpCapabilities,
          room: consumeRoom,
        } = msg;
        if (!transportId || !producerId || !rtpCapabilities)
          return sendError(
            "transportId, producerId and rtpCapabilities required"
          );
        if (!consumeRoom) return sendError("room required");
        try {
          const roomObj = rooms.get(consumeRoom);
          if (!roomObj) return sendError("room not found");
          if (!roomObj.producers.has(producerId))
            return sendError("producer not available in room");
          const clientObj = clients.get(clientId);
          if (!clientObj.transports.has(transportId))
            return sendError("transport not found");
          const { consumerId, consumer } = await sfu.createConsumer({
            transportId,
            producerId,
            rtpCapabilities,
            clientId,
          });
          clientObj.consumers.add(consumerId);
          send(ws, {
            type: "sfu.consumed",
            consumerId,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            requestId: msg.requestId || null,
          });
        } catch (err) {
          console.error("sfu.consume failed", err);
          sendError("sfu.consume failed");
        }
        return;
      }

      case "sfu.listProducers": {
        if (!sfu) return sendError("sfu not enabled on server");
        const { room: targetRoom } = msg;
        if (!targetRoom) return sendError("room required");
        const roomObj = rooms.get(targetRoom);
        if (!roomObj) return sendError("room not found");
        const producersPayload = roomProducersPayload(roomObj);
        send(ws, {
          type: "sfu.producers",
          room: targetRoom,
          producers: producersPayload,
        });
        return;
      }

      case "sfu.closeProducer": {
        const clientObj = clients.get(clientId);
        if (!clientObj || !clientObj.producers.size)
          return sendError("no producers for client");
        const { producerId } = msg;
        if (!producerId) return sendError("producerId required");
        try {
          if (sfu && sfu.closeProducer) {
            await sfu.closeProducer(producerId);
          }
          clientObj.producers.delete(producerId);
          send(ws, { type: "sfu.producerClosed", producerId });
        } catch (err) {
          console.error("sfu.closeProducer failed", err);
          sendError("sfu.closeProducer failed");
        }
        return;
      }

      // --- admin handlers ---
      case "admin.rooms": {
        const clientObj = clients.get(clientId);
        if (!clientObj || !clientObj.user || clientObj.user.role !== "admin")
          return sendError("admin access required");
        const payload = Array.from(rooms.entries()).map(([name, roomObj]) => ({
          name,
          count: roomObj.members.size,
          ownerId: roomObj.ownerId,
          moderators: Array.from(roomObj.moderators),
        }));
        send(ws, { type: "admin.rooms", rooms: payload });
        return;
      }

      case "admin.roomInfo": {
        const clientObj = clients.get(clientId);
        if (!clientObj || !clientObj.user || clientObj.user.role !== "admin")
          return sendError("admin access required");
        const { room: queryRoom } = msg;
        if (!queryRoom) return sendError("room required");
        const roomObj = rooms.get(queryRoom);
        if (!roomObj) return sendError("room not found");
        const members = [];
        for (const memberId of roomObj.members) {
          const m = clients.get(memberId);
          members.push({
            id: memberId,
            user: m && m.user,
            producers: m ? Array.from(m.producers) : [],
            role: roomObj.memberRoles.get(memberId),
          });
        }
        send(ws, {
          type: "admin.roomInfo",
          room: queryRoom,
          members,
          options: roomObj.options,
          ownerId: roomObj.ownerId,
          moderators: Array.from(roomObj.moderators),
        });
        return;
      }

      case "admin.metrics": {
        const clientObj = clients.get(clientId);
        if (!clientObj || !clientObj.user || clientObj.user.role !== "admin")
          return sendError("admin access required");
        if (!sfu || !sfu.getMetrics)
          return send(ws, { type: "admin.metrics", metrics: null });
        send(ws, { type: "admin.metrics", metrics: sfu.getMetrics() });
        return;
      }

      case "offer":
      case "answer":
      case "candidate": {
        if (room) {
          const roomObj = rooms.get(room);
          if (!roomObj) {
            send(ws, { type: "error", message: "room not found: " + room });
            return;
          }
          msg.from = clientId;
          for (const memberId of roomObj.members) {
            if (memberId === clientId) continue;
            const memberObj = clients.get(memberId);
            const memberWs = memberObj && memberObj.ws;
            if (memberWs) send(memberWs, msg);
          }
          return;
        }

        if (!to) {
          send(ws, {
            type: "error",
            message: "`to` field required for " + type,
          });
          return;
        }
        const targetObj = clients.get(to);
        const targetWs = targetObj && targetObj.ws;
        if (!targetWs) {
          send(ws, { type: "error", message: "target not found: " + to });
          return;
        }
        msg.from = clientId;
        send(targetWs, msg);
        break;
      }

      case "list":
        send(ws, { type: "list", clients: Array.from(clients.keys()) });
        break;

      case "rooms":
        send(ws, {
          type: "rooms",
          rooms: Array.from(rooms.entries()).map(([name, roomObj]) => ({
            name,
            count: roomObj.members.size,
          })),
        });
        break;

      case "join": {
        if (!room) {
          send(ws, { type: "error", message: "room required for join" });
          return;
        }
        // allow role: publisher or observer (default publisher)
        const { role } = msg;
        const clientObj = clients.get(clientId);
        let desiredRole;
        if (role === "observer") desiredRole = "observer";
        else if (role === "moderator") desiredRole = "moderator";
        else desiredRole = "publisher";

        if (desiredRole === "moderator") {
          if (!clientObj.user || clientObj.user.role !== "admin")
            return sendError("only admin users can join as moderator");
        }

        const roomObj = ensureRoom(room);

        if (desiredRole === "observer") {
          if (!roomObj.options.allowObservers)
            return sendError("observers disabled for this room");
          if (
            roomObj.options.maxObservers > 0 &&
            roomObj.observers.size >= roomObj.options.maxObservers
          )
            return sendError("observer limit reached");
        }

        clientObj.role = desiredRole;
        roomObj.members.add(clientId);
        roomObj.memberRoles.set(clientId, desiredRole);
        if (desiredRole === "observer") roomObj.observers.add(clientId);
        if (!roomObj.ownerId && desiredRole !== "observer")
          roomObj.ownerId = clientId;
        if (desiredRole === "moderator") roomObj.moderators.add(clientId);

        clientObj.rooms.add(room);
        send(ws, { type: "joined", room, id: clientId, role: clientObj.role });
        for (const memberId of roomObj.members) {
          if (memberId === clientId) continue;
          const memberObj = clients.get(memberId);
          const memberWs = memberObj && memberObj.ws;
          if (memberWs)
            send(memberWs, {
              type: "member-joined",
              room,
              id: clientId,
              role: clientObj.role,
            });
        }
        if (clientObj.role === "observer") {
          const producersPayload = roomProducersPayload(roomObj);
          send(ws, {
            type: "sfu.producers",
            room,
            producers: producersPayload,
          });
        }
        break;
      }

      case "leaveRoom": {
        if (!room) {
          send(ws, { type: "error", message: "room required for leaveRoom" });
          return;
        }
        if (!rooms.has(room)) {
          send(ws, { type: "error", message: "room not found: " + room });
          return;
        }
        const roomObj = rooms.get(room);
        const clientObj = clients.get(clientId);
        closeClientProducersInRoom(roomObj, clientId);
        removeMemberFromRoom(roomObj, clientId);
        clientObj.rooms.delete(room);
        send(ws, { type: "left", room, id: clientId });
        for (const memberId of roomObj.members) {
          const memberObj = clients.get(memberId);
          const memberWs = memberObj && memberObj.ws;
          if (memberWs)
            send(memberWs, { type: "member-left", room, id: clientId });
        }
        if (roomObj.members.size === 0) rooms.delete(room);
        break;
      }

      case "leave":
        break;

      default:
        send(ws, { type: "error", message: "unknown message type: " + type });
    }
  }

  wss.on("connection", (ws, req) => {
    const clientId = uuidv4();

    // extract token from querystring
    const parsed = url.parse(req.url, true);
    const token = parsed.query && parsed.query.token;
    const user = validateToken(token);

    if (REQUIRE_AUTH && !user) {
      console.log("unauthorized connection - closing");
      send(ws, { type: "error", message: "unauthorized" });
      ws.close();
      return;
    }

    // attach empty maps for SFU bookkeeping
    clients.set(clientId, {
      ws,
      user,
      role: "publisher",
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
      rooms: new Set(),
    });
    console.log("Client connected:", clientId, "user:", user && user.id);
    send(ws, { type: "id", id: clientId });

    ws.on("message", (data) => handleMessage(ws, clientId, data));

    ws.on("close", () => {
      // cleanup any SFU resources (close transports/producers/consumers)
      const clientObj = clients.get(clientId);
      if (clientObj) {
        for (const [roomName, roomObj] of Array.from(rooms.entries())) {
          if (!roomObj.members.has(clientId)) continue;
          closeClientProducersInRoom(roomObj, clientId);
          removeMemberFromRoom(roomObj, clientId);
          for (const memberId of roomObj.members) {
            const memberObj = clients.get(memberId);
            const memberWs = memberObj && memberObj.ws;
            if (memberWs)
              send(memberWs, {
                type: "member-left",
                room: roomName,
                id: clientId,
              });
          }
          if (roomObj.members.size === 0) rooms.delete(roomName);
        }
        if (sfu && sfu.closeClient) {
          try {
            sfu.closeClient(clientId);
          } catch (err) {
            console.warn("failed to close SFU state for client", err);
          }
        }
      }
      clients.delete(clientId);
      console.log("Client disconnected:", clientId);
      for (const [id, clientObj] of clients.entries()) {
        send(clientObj.ws, { type: "leave", id: clientId });
      }
    });

    ws.on("error", (err) => {
      console.error("ws error", err);
    });
  });

  // admin helpers exposed to outer code
  function getRooms() {
    return Array.from(rooms.entries()).map(([name, roomObj]) => ({
      name,
      count: roomObj.members.size,
    }));
  }

  function getRoomInfo(name) {
    const roomObj = rooms.get(name);
    if (!roomObj) return null;
    const members = [];
    for (const memberId of roomObj.members) {
      const m = clients.get(memberId);
      members.push({
        id: memberId,
        user: m && m.user,
        producers: m && m.producers ? Array.from(m.producers.keys()) : [],
        role: m && m.role,
      });
    }
    return {
      name,
      members,
      options: roomObj.options,
      ownerId: roomObj.ownerId,
      moderators: Array.from(roomObj.moderators),
    };
  }

  return { getRooms, getRoomInfo };
}

module.exports = { createSignalingServer };
