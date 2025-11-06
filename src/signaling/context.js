const { getRoomDefaults, getIceServers } = require("../config");

const WS_STATE_OPEN = 1;

function createSignalingContext({ sfu }) {
  const clients = new Map();
  const rooms = new Map();

  function requireAuth() {
    return Number(process.env.ENABLE_AUTH) === 1;
  }

  function ensureRoom(name) {
    if (!rooms.has(name)) {
      rooms.set(name, {
        name,
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

  function addClient(clientId, ws, user) {
    const client = {
      id: clientId,
      ws,
      user,
      role: "publisher",
      transports: new Set(),
      transportInfo: new Map(),
      producers: new Set(),
      consumers: new Set(),
      rooms: new Set(),
    };
    clients.set(clientId, client);
    return client;
  }

  function getClient(clientId) {
    return clients.get(clientId) || null;
  }

  function removeClient(clientId) {
    clients.delete(clientId);
  }

  function sendToClient(clientId, payload) {
    const client = getClient(clientId);
    if (!client || !client.ws || client.ws.readyState !== WS_STATE_OPEN) {
      return false;
    }
    try {
      client.ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn("Failed to send message", err.message);
      return false;
    }
  }

  function broadcastToRoom(roomName, payload, { exclude } = {}) {
    const room = rooms.get(roomName);
    if (!room) return;
    for (const memberId of room.members) {
      if (exclude && memberId === exclude) continue;
      sendToClient(memberId, payload);
    }
  }

  function roomProducersPayload(room) {
    if (!room || !room.producers) return [];
    return Array.from(room.producers.entries()).map(([producerId, info]) => ({
      producerId,
      kind: info.kind,
      clientId: info.clientId,
    }));
  }

  async function closeClientProducers(roomName, clientId) {
    const room = rooms.get(roomName);
    if (!room) return;
    const client = clients.get(clientId);
    const toClose = [];
    for (const [producerId, info] of room.producers.entries()) {
      if (info.clientId === clientId) toClose.push(producerId);
    }
    for (const producerId of toClose) {
      if (sfu && sfu.closeProducer) {
        try {
          await sfu.closeProducer(producerId);
        } catch (err) {
          console.warn("Failed to close producer", producerId, err.message);
        }
      }
      room.producers.delete(producerId);
      if (client) client.producers.delete(producerId);
    }
  }

  function removeMemberFromRoom(roomName, clientId) {
    const room = rooms.get(roomName);
    if (!room) return;
    room.members.delete(clientId);
    room.memberRoles.delete(clientId);
    room.observers.delete(clientId);
    if (room.ownerId === clientId) {
      room.ownerId = null;
      for (const [memberId, role] of room.memberRoles.entries()) {
        if (role === "publisher" || role === "moderator") {
          room.ownerId = memberId;
          break;
        }
      }
    }
    room.moderators.delete(clientId);
  }

  function deleteRoomIfEmpty(roomName) {
    const room = rooms.get(roomName);
    if (room && room.members.size === 0) {
      rooms.delete(roomName);
    }
  }

  async function removeClientFromAllRooms(clientId) {
    const client = clients.get(clientId);
    for (const [roomName, room] of rooms.entries()) {
      if (!room.members.has(clientId)) continue;
      await closeClientProducers(roomName, clientId);
      removeMemberFromRoom(roomName, clientId);
      broadcastToRoom(roomName, {
        type: "member-left",
        room: roomName,
        id: clientId,
      });
      deleteRoomIfEmpty(roomName);
    }
    if (client) client.rooms.clear();
  }

  async function closeClientResources(clientId) {
    const client = getClient(clientId);
    if (!client) return;

    for (const transportId of Array.from(client.transports)) {
      if (sfu && sfu.closeTransport) {
        try {
          await sfu.closeTransport(transportId);
        } catch (err) {
          console.warn("Failed to close transport", transportId, err.message);
        }
      }
      client.transportInfo.delete(transportId);
      client.transports.delete(transportId);
    }

    for (const producerId of Array.from(client.producers)) {
      if (sfu && sfu.closeProducer) {
        try {
          await sfu.closeProducer(producerId);
        } catch (err) {
          console.warn("Failed to close producer", producerId, err.message);
        }
      }
      client.producers.delete(producerId);
    }

    for (const consumerId of Array.from(client.consumers)) {
      if (sfu && sfu.closeConsumer) {
        try {
          await sfu.closeConsumer(consumerId);
        } catch (err) {
          console.warn("Failed to close consumer", consumerId, err.message);
        }
      }
      client.consumers.delete(consumerId);
    }
  }

  function getRoomsOverview() {
    return Array.from(rooms.entries()).map(([name, room]) => ({
      name,
      count: room.members.size,
      ownerId: room.ownerId,
      moderators: Array.from(room.moderators),
    }));
  }

  function getRoomInfo(name) {
    const room = rooms.get(name);
    if (!room) return null;
    const members = [];
    for (const memberId of room.members) {
      const client = clients.get(memberId);
      members.push({
        id: memberId,
        user: client && client.user,
        producers: client ? Array.from(client.producers) : [],
        role: room.memberRoles.get(memberId),
      });
    }
    return {
      name,
      members,
      options: room.options,
      ownerId: room.ownerId,
      moderators: Array.from(room.moderators),
    };
  }

  return {
    sfu,
    clients,
    rooms,
    config: {
      get requireAuth() {
        return requireAuth();
      },
    },
    ensureRoom,
    addClient,
    getClient,
    removeClient,
    sendToClient,
    broadcastToRoom,
    roomProducersPayload,
    closeClientProducers,
    removeMemberFromRoom,
    deleteRoomIfEmpty,
    removeClientFromAllRooms,
    closeClientResources,
    getRoomsOverview,
    getRoomInfo,
    getIceServers,
    getRoomDefaults,
  };
}

module.exports = { createSignalingContext };
