function registerSfuEvents(context) {
  const { sfu, clients, rooms, broadcastToRoom } = context;
  if (!sfu) return;

  sfu.on("transport-closed", ({ clientId, transportId }) => {
    const client = clients.get(clientId);
    if (!client) return;
    client.transports.delete(transportId);
    if (client.transportInfo) client.transportInfo.delete(transportId);
  });

  sfu.on("producer-closed", ({ producerId, roomName, clientId }) => {
    const room = rooms.get(roomName);
    if (room && room.producers.has(producerId)) {
      room.producers.delete(producerId);
    }
    const client = clients.get(clientId);
    if (client) {
      client.producers.delete(producerId);
    }
    broadcastToRoom(roomName, {
      type: "sfu.producerClosed",
      room: roomName,
      producerId,
      clientId,
    });
  });

  sfu.on("consumer-closed", ({ clientId, consumerId }) => {
    const client = clients.get(clientId);
    if (!client) return;
    client.consumers.delete(consumerId);
  });
}

module.exports = { registerSfuEvents };
