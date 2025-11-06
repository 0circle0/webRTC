const { getIceServers } = require("../config");

function createMessageRouter(context) {
  const {
    sfu,
    clients,
    rooms,
    ensureRoom,
    broadcastToRoom,
    roomProducersPayload,
    closeClientProducers,
    removeMemberFromRoom,
    deleteRoomIfEmpty,
    getRoomsOverview,
    getRoomInfo,
  } = context;

  const send = (ws, message) => {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.warn("Failed to send WebSocket message", err.message);
    }
  };

  const sendError = (ws, message) => send(ws, { type: "error", message });

  async function handleCreateTransport(clientId, ws, msg) {
    if (!sfu) return sendError(ws, "sfu not enabled on server");
    const { direction = "send", room: targetRoom } = msg;
    if (!targetRoom)
      return sendError(ws, "room required when creating transport");
    const client = clients.get(clientId);
    if (!client) return sendError(ws, "client not found");
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
      client.transports.add(transportId);
      if (!client.transportInfo) client.transportInfo = new Map();
      client.transportInfo.set(transportId, {
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
      sendError(ws, "sfu.createTransport failed");
    }
  }

  async function handleConnectTransport(clientId, ws, msg) {
    if (!sfu) return sendError(ws, "sfu not enabled on server");
    const { transportId, dtlsParameters } = msg;
    if (!transportId || !dtlsParameters)
      return sendError(ws, "transportId and dtlsParameters required");
    const client = clients.get(clientId);
    if (!client || !client.transports.has(transportId))
      return sendError(ws, "transport not found");
    try {
      await sfu.connectTransport({ transportId, dtlsParameters });
      send(ws, {
        type: "sfu.transportConnected",
        transportId,
        requestId: msg.requestId || null,
      });
    } catch (err) {
      console.error("sfu.connectTransport failed", err);
      sendError(ws, "sfu.connectTransport failed");
    }
  }

  function handleIce(clientId, ws, msg) {
    const { candidate, to, room } = msg;
    if (!candidate) return sendError(ws, "candidate required");
    if (to) {
      const target = clients.get(to);
      if (!target || !target.ws) return sendError(ws, "target not found");
      send(target.ws, { type: "ice", from: clientId, candidate });
      return;
    }
    if (room) {
      const roomObj = rooms.get(room);
      if (!roomObj) return sendError(ws, "room not found");
      for (const memberId of roomObj.members) {
        if (memberId === clientId) continue;
        const memberObj = clients.get(memberId);
        if (memberObj && memberObj.ws)
          send(memberObj.ws, { type: "ice", from: clientId, candidate });
      }
      return;
    }
    sendError(ws, "to or room required for ice");
  }

  async function handleProduce(clientId, ws, msg) {
    if (!sfu) return sendError(ws, "sfu not enabled on server");
    const { transportId, kind, rtpParameters, room: produceRoom } = msg;
    if (!transportId || !kind || !rtpParameters)
      return sendError(ws, "transportId, kind and rtpParameters required");
    if (!produceRoom) return sendError(ws, "room required when producing");
    const client = clients.get(clientId);
    if (!client) return sendError(ws, "client not found");
    if (client.role === "observer")
      return sendError(ws, "observers cannot produce");
    if (!client.transports.has(transportId))
      return sendError(ws, "transport not found");

    const roomObj = ensureRoom(produceRoom);
    const maxVideo =
      typeof roomObj.options.maxVideoProducers === "number"
        ? roomObj.options.maxVideoProducers
        : 0;
    if (kind === "video" && maxVideo > 0) {
      const videoCount = Array.from(roomObj.producers.values()).filter(
        (info) => info.kind === "video"
      ).length;
      if (videoCount >= maxVideo)
        return sendError(ws, `room already has ${maxVideo} video producers`);
    }

    try {
      const { producerId } = await sfu.createProducer({
        transportId,
        roomName: produceRoom,
        clientId,
        kind,
        rtpParameters,
      });
      client.producers.add(producerId);
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
      broadcastToRoom(
        produceRoom,
        {
          type: "sfu.newProducer",
          room: produceRoom,
          producerId,
          clientId,
          producerUser: client.user && client.user.id,
          kind,
        },
        { exclude: clientId }
      );
    } catch (err) {
      console.error("sfu.produce failed", err);
      sendError(ws, "sfu.produce failed");
    }
  }

  async function handleConsume(clientId, ws, msg) {
    if (!sfu) return sendError(ws, "sfu not enabled on server");
    const { transportId, producerId, rtpCapabilities, room: consumeRoom } = msg;
    if (!transportId || !producerId || !rtpCapabilities)
      return sendError(
        ws,
        "transportId, producerId and rtpCapabilities required"
      );
    if (!consumeRoom) return sendError(ws, "room required");
    const roomObj = rooms.get(consumeRoom);
    if (!roomObj) return sendError(ws, "room not found");
    if (!roomObj.producers.has(producerId))
      return sendError(ws, "producer not available in room");
    const client = clients.get(clientId);
    if (!client || !client.transports.has(transportId))
      return sendError(ws, "transport not found");
    try {
      const { consumerId, consumer } = await sfu.createConsumer({
        transportId,
        producerId,
        rtpCapabilities,
        clientId,
      });
      client.consumers.add(consumerId);
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
      sendError(ws, "sfu.consume failed");
    }
  }

  function handleListProducers(clientId, ws, msg) {
    if (!sfu) return sendError(ws, "sfu not enabled on server");
    const { room: targetRoom } = msg;
    if (!targetRoom) return sendError(ws, "room required");
    const roomObj = rooms.get(targetRoom);
    if (!roomObj) return sendError(ws, "room not found");
    send(ws, {
      type: "sfu.producers",
      room: targetRoom,
      producers: roomProducersPayload(roomObj),
    });
  }

  async function handleCloseProducer(clientId, ws, msg) {
    const client = clients.get(clientId);
    if (!client || !client.producers.size)
      return sendError(ws, "no producers for client");
    const { producerId } = msg;
    if (!producerId) return sendError(ws, "producerId required");
    try {
      if (sfu && sfu.closeProducer) {
        await sfu.closeProducer(producerId);
      }
      client.producers.delete(producerId);
      send(ws, { type: "sfu.producerClosed", producerId });
    } catch (err) {
      console.error("sfu.closeProducer failed", err);
      sendError(ws, "sfu.closeProducer failed");
    }
  }

  function handleAdminRooms(clientId, ws) {
    const client = clients.get(clientId);
    if (!client || !client.user || client.user.role !== "admin")
      return sendError(ws, "admin access required");
    send(ws, { type: "admin.rooms", rooms: getRoomsOverview() });
  }

  function handleAdminRoomInfo(clientId, ws, msg) {
    const client = clients.get(clientId);
    if (!client || !client.user || client.user.role !== "admin")
      return sendError(ws, "admin access required");
    const { room: queryRoom } = msg;
    if (!queryRoom) return sendError(ws, "room required");
    const info = getRoomInfo(queryRoom);
    if (!info) return sendError(ws, "room not found");
    send(ws, { type: "admin.roomInfo", room: queryRoom, ...info });
  }

  function handleAdminMetrics(clientId, ws) {
    const client = clients.get(clientId);
    if (!client || !client.user || client.user.role !== "admin")
      return sendError(ws, "admin access required");
    const metrics = sfu && sfu.getMetrics ? sfu.getMetrics() : null;
    send(ws, { type: "admin.metrics", metrics });
  }

  function handleLegacyRelay(clientId, ws, msg) {
    const { type, room, to } = msg;
    if (room) {
      const roomObj = rooms.get(room);
      if (!roomObj) {
        sendError(ws, "room not found: " + room);
        return;
      }
      msg.from = clientId;
      for (const memberId of roomObj.members) {
        if (memberId === clientId) continue;
        const memberObj = clients.get(memberId);
        if (memberObj && memberObj.ws) send(memberObj.ws, msg);
      }
      return;
    }
    if (!to) {
      sendError(ws, `\`to\` field required for ${type}`);
      return;
    }
    const target = clients.get(to);
    if (!target || !target.ws) {
      sendError(ws, "target not found: " + to);
      return;
    }
    msg.from = clientId;
    send(target.ws, msg);
  }

  function handleList(ws) {
    send(ws, { type: "list", clients: Array.from(clients.keys()) });
  }

  function handleRooms(ws) {
    const payload = Array.from(rooms.entries()).map(([name, room]) => ({
      name,
      count: room.members.size,
    }));
    send(ws, { type: "rooms", rooms: payload });
  }

  async function handleJoin(clientId, ws, msg) {
    const { room, role } = msg;
    if (!room) {
      sendError(ws, "room required for join");
      return;
    }
    const client = clients.get(clientId);
    if (!client) {
      sendError(ws, "client not found");
      return;
    }
    let desiredRole = "publisher";
    if (role === "observer") desiredRole = "observer";
    else if (role === "moderator") desiredRole = "moderator";

    if (desiredRole === "moderator") {
      if (!client.user || client.user.role !== "admin") {
        sendError(ws, "only admin users can join as moderator");
        return;
      }
    }

    const roomObj = ensureRoom(room);

    if (desiredRole === "observer") {
      if (!roomObj.options.allowObservers) {
        sendError(ws, "observers disabled for this room");
        return;
      }
      if (
        roomObj.options.maxObservers > 0 &&
        roomObj.observers.size >= roomObj.options.maxObservers
      ) {
        sendError(ws, "observer limit reached");
        return;
      }
      roomObj.observers.add(clientId);
    }

    client.role = desiredRole;
    roomObj.members.add(clientId);
    roomObj.memberRoles.set(clientId, desiredRole);
    if (!roomObj.ownerId && desiredRole !== "observer") {
      roomObj.ownerId = clientId;
    }
    if (desiredRole === "moderator") {
      roomObj.moderators.add(clientId);
    }

    client.rooms.add(room);
    send(ws, { type: "joined", room, id: clientId, role: desiredRole });

    broadcastToRoom(
      room,
      {
        type: "member-joined",
        room,
        id: clientId,
        role: desiredRole,
      },
      { exclude: clientId }
    );

    if (desiredRole === "observer") {
      send(ws, {
        type: "sfu.producers",
        room,
        producers: roomProducersPayload(roomObj),
      });
    }
  }

  async function handleLeaveRoom(clientId, ws, msg) {
    const { room } = msg;
    if (!room) return sendError(ws, "room required for leaveRoom");
    const roomObj = rooms.get(room);
    if (!roomObj) return sendError(ws, "room not found: " + room);
    await closeClientProducers(room, clientId);
    removeMemberFromRoom(room, clientId);
    const client = clients.get(clientId);
    if (client) client.rooms.delete(room);
    send(ws, { type: "left", room, id: clientId });
    broadcastToRoom(room, { type: "member-left", room, id: clientId });
    deleteRoomIfEmpty(room);
  }

  const handlers = {
    "sfu.createTransport": handleCreateTransport,
    "sfu.connectTransport": handleConnectTransport,
    ice: handleIce,
    "sfu.produce": handleProduce,
    "sfu.consume": handleConsume,
    "sfu.listProducers": handleListProducers,
    "sfu.closeProducer": handleCloseProducer,
    "admin.rooms": handleAdminRooms,
    "admin.roomInfo": handleAdminRoomInfo,
    "admin.metrics": handleAdminMetrics,
    offer: handleLegacyRelay,
    answer: handleLegacyRelay,
    candidate: handleLegacyRelay,
    list: (_clientId, ws) => handleList(ws),
    rooms: (_clientId, ws) => handleRooms(ws),
    join: handleJoin,
    leaveRoom: handleLeaveRoom,
    leave: () => {},
  };

  return async function routeMessage(clientId, ws, data) {
    let payload;
    let text;
    try {
      text = typeof data === "string" ? data : data.toString();
      payload = JSON.parse(text);
    } catch (err) {
      console.warn("Failed to parse message from", clientId, err.message);
      return;
    }

    const handler = handlers[payload.type];
    if (!handler) {
      sendError(ws, "unknown message type: " + (payload.type || "unknown"));
      return;
    }

    try {
      await handler(clientId, ws, payload);
    } catch (err) {
      console.error("Signaling handler error", payload.type, err);
      sendError(ws, "handler error");
    }
  };
}

module.exports = { createMessageRouter };
