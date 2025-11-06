const { getListenIps, getIceServers } = require("../config");

function createSfuOperations(context) {
  const { emitter, options } = context;

  async function createWebRtcTransport({
    roomName,
    clientId,
    direction = "send",
  }) {
    if (!roomName) throw new Error("roomName required");
    const roomCtx = await context.ensureRoomContext(roomName);
    const listenIps = options.listenIps || getListenIps();
    console.log("Creating WebRTC transport", {
      room: roomName,
      clientId,
      direction,
      listenIps,
    });

    const transport = await roomCtx.router.createWebRtcTransport({
      listenIps,
      enableUdp: options.enableUdp,
      enableTcp: options.enableTcp,
      preferUdp: options.preferUdp,
      appData: { roomName, clientId, direction },
    });

    context.registerTransport(transport, { roomName, clientId, direction });

    const cleanup = (reason) => {
      const meta = context.unregisterTransport(transport.id) || {
        roomName,
        clientId,
        direction,
      };
      emitter.emit("transport-closed", {
        roomName: meta.roomName,
        clientId: meta.clientId,
        transportId: transport.id,
        direction: meta.direction,
        reason,
      });
    };

    transport.on("close", () => cleanup("close"));
    transport.on("routerclose", () => cleanup("routerclose"));

    return {
      transport,
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers: getIceServers(),
      routerRtpCapabilities: roomCtx.router.rtpCapabilities,
      roomName,
      direction,
    };
  }

  async function connectTransport({ transportId, dtlsParameters }) {
    const meta = context.getTransport(transportId);
    if (!meta) throw new Error("transport not found");
    await meta.transport.connect({ dtlsParameters });
    return { transportId };
  }

  async function closeTransport(transportId) {
    const meta = context.getTransport(transportId);
    if (!meta) return false;
    meta.transport.close();
    return true;
  }

  async function createProducer({
    transportId,
    roomName,
    clientId,
    kind,
    rtpParameters,
  }) {
    const transportMeta = context.getTransport(transportId);
    if (!transportMeta) throw new Error("transport not found");
    if (roomName && transportMeta.roomName !== roomName)
      throw new Error("transport belongs to different room");

    const producer = await transportMeta.transport.produce({
      kind,
      rtpParameters,
      appData: { roomName: transportMeta.roomName, clientId },
    });

    const roomCtx = await context.ensureRoomContext(transportMeta.roomName);
    context.registerProducer(producer, {
      roomName: transportMeta.roomName,
      clientId,
      kind,
    });

    const cleanup = (reason) => {
      const meta = context.unregisterProducer(producer.id) || {
        roomName: transportMeta.roomName,
        clientId,
        kind,
      };
      emitter.emit("producer-closed", {
        producerId: producer.id,
        roomName: meta.roomName,
        clientId: meta.clientId,
        kind: meta.kind,
        reason,
      });
    };

    producer.on("transportclose", () => cleanup("transportclose"));
    producer.on("close", () => cleanup("close"));

    return { producer, producerId: producer.id };
  }

  async function createConsumer({
    transportId,
    producerId,
    rtpCapabilities,
    clientId,
  }) {
    const transportMeta = context.getTransport(transportId);
    if (!transportMeta) throw new Error("transport not found");
    const producerMeta = context.getProducer(producerId);
    if (!producerMeta) throw new Error("producer not found");

    const roomCtx = await context.ensureRoomContext(producerMeta.roomName);
    if (
      !roomCtx.router.canConsume({
        producerId: producerMeta.producer.id,
        rtpCapabilities,
      })
    ) {
      throw new Error("cannot consume with provided rtpCapabilities");
    }

    const consumer = await transportMeta.transport.consume({
      producerId: producerMeta.producer.id,
      rtpCapabilities,
      paused: false,
      appData: { roomName: producerMeta.roomName, clientId },
    });

    try {
      await consumer.resume();
    } catch (err) {
      console.warn(
        "Failed to resume consumer immediately",
        consumer.id,
        err.message
      );
    }

    context.registerConsumer(consumer, {
      roomName: producerMeta.roomName,
      clientId,
    });

    const cleanup = (reason) => {
      const meta = context.unregisterConsumer(consumer.id) || {
        roomName: producerMeta.roomName,
        clientId,
      };
      emitter.emit("consumer-closed", {
        roomName: meta.roomName,
        clientId: meta.clientId,
        consumerId: consumer.id,
        reason,
      });
    };

    consumer.on("transportclose", () => cleanup("transportclose"));
    consumer.on("producerclose", () => cleanup("producerclose"));
    consumer.on("close", () => cleanup("close"));

    return { consumer, consumerId: consumer.id };
  }

  function closeClient(clientId) {
    context.closeClientResources(clientId);
  }

  async function closeProducer(producerId) {
    const meta = context.getProducer(producerId);
    if (!meta) return false;
    meta.producer.close();
    return true;
  }

  async function closeConsumer(consumerId) {
    const meta = context.getConsumer(consumerId);
    if (!meta) return false;
    meta.consumer.close();
    return true;
  }

  function getRoomsOverview() {
    return context.getRoomsOverview();
  }

  function getMetrics() {
    return context.getMetrics();
  }

  return {
    createWebRtcTransport,
    connectTransport,
    closeTransport,
    createProducer,
    createConsumer,
    closeClient,
    closeProducer,
    closeConsumer,
    getRoomsOverview,
    getMetrics,
  };
}

module.exports = { createSfuOperations };
