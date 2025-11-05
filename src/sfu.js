// Advanced mediasoup SFU manager. This module keeps room-level state, exposes
// helpers to create transports/producers/consumers, and emits events so the
// signaling layer can remain lean. The SFU is optional – if mediasoup is not
// installed the caller is expected to handle the thrown error and fall back to
// pure signaling.

const os = require("os");
const { EventEmitter } = require("events");
const { getListenIps, getIceServers } = require("./config");

function createSFUServer(opts = {}) {
  let mediasoup;
  try {
    mediasoup = require("mediasoup");
  } catch (err) {
    console.error("mediasoup not installed. Required for server startup. Run:");
    console.error("  npm install --save mediasoup");
    console.error(
      "See https://mediasoup.org/ for installation notes (native deps)"
    );
    throw err;
  }

  const workers = [];
  const transports = new Map();
  const producers = new Map();
  const consumers = new Map();
  const rooms = new Map();
  const emitter = new EventEmitter();

  const numWorkers = opts.numWorkers || Math.max(1, os.cpus().length - 1);
  const mediaCodecs = opts.mediaCodecs || [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
    },
    {
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: {
        "level-asymmetry-allowed": 1,
        "packetization-mode": 1,
        "profile-level-id": "42e01f",
      },
    },
  ];

  async function ensureWorkers() {
    if (workers.length) return;
    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: opts.logLevel || "warn",
        rtcMinPort: opts.rtcMinPort,
        rtcMaxPort: opts.rtcMaxPort,
        logTags: opts.logTags || ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      });
      worker.on("died", () => {
        console.error("mediasoup worker died, exiting");
        process.exit(1);
      });
      workers.push(worker);
    }
    console.log(`Created ${workers.length} mediasoup worker(s)`);
  }

  let workerIndex = 0;
  async function getWorker() {
    await ensureWorkers();
    const worker = workers[workerIndex % workers.length];
    workerIndex = (workerIndex + 1) % workers.length;
    return worker;
  }

  async function getRoomContext(roomName) {
    if (rooms.has(roomName)) return rooms.get(roomName);
    const worker = await getWorker();
    const router = await worker.createRouter({ mediaCodecs });
    const ctx = {
      name: roomName,
      router,
      transports: new Set(),
      producers: new Set(),
      consumers: new Set(),
      metrics: {
        createdAt: Date.now(),
        totalProducers: 0,
        totalConsumers: 0,
      },
    };
    rooms.set(roomName, ctx);
    return ctx;
  }

  function getTransport(transportId) {
    return transports.get(transportId);
  }

  function getProducer(producerId) {
    return producers.get(producerId);
  }

  async function createWebRtcTransport({
    roomName,
    clientId,
    direction = "send",
  }) {
    const roomCtx = await getRoomContext(roomName);
    const listenIps = opts.listenIps || getListenIps();
    const transport = await roomCtx.router.createWebRtcTransport({
      listenIps,
      enableUdp: opts.enableUdp !== false,
      enableTcp: opts.enableTcp !== false,
      preferUdp: opts.preferUdp !== false,
      appData: { roomName, clientId, direction },
    });

    const meta = { transport, roomName, clientId, direction };
    transports.set(transport.id, meta);
    roomCtx.transports.add(transport.id);

    const cleanup = () => {
      transports.delete(transport.id);
      roomCtx.transports.delete(transport.id);
      emitter.emit("transport-closed", {
        roomName,
        clientId,
        transportId: transport.id,
      });
    };
    transport.on("close", cleanup);
    transport.on("routerclose", cleanup);

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
    const meta = getTransport(transportId);
    if (!meta) throw new Error("transport not found");
    await meta.transport.connect({ dtlsParameters });
    return { transportId };
  }

  async function closeTransport(transportId) {
    const meta = getTransport(transportId);
    if (!meta) return;
    meta.transport.close();
  }

  async function createProducer({
    transportId,
    roomName,
    clientId,
    kind,
    rtpParameters,
  }) {
    const meta = getTransport(transportId);
    if (!meta) throw new Error("transport not found");
    if (roomName && meta.roomName !== roomName)
      throw new Error("transport belongs to different room");
    const producer = await meta.transport.produce({
      kind,
      rtpParameters,
      appData: { roomName: meta.roomName, clientId },
    });
    const roomCtx = await getRoomContext(meta.roomName);

    producers.set(producer.id, { producer, roomName: meta.roomName, clientId });
    roomCtx.producers.add(producer.id);
    roomCtx.metrics.totalProducers++;

    const cleanup = (reason) => {
      producers.delete(producer.id);
      roomCtx.producers.delete(producer.id);
      emitter.emit("producer-closed", {
        producerId: producer.id,
        roomName: meta.roomName,
        clientId,
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
    const transportMeta = getTransport(transportId);
    if (!transportMeta) throw new Error("transport not found");
    const producerMeta = getProducer(producerId);
    if (!producerMeta) throw new Error("producer not found");

    const roomCtx = await getRoomContext(producerMeta.roomName);
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

    consumers.set(consumer.id, {
      consumer,
      roomName: producerMeta.roomName,
      clientId,
    });
    roomCtx.consumers.add(consumer.id);
    roomCtx.metrics.totalConsumers++;

    const cleanup = () => {
      consumers.delete(consumer.id);
      roomCtx.consumers.delete(consumer.id);
      emitter.emit("consumer-closed", {
        roomName: producerMeta.roomName,
        clientId,
        consumerId: consumer.id,
      });
    };
    consumer.on("transportclose", cleanup);
    consumer.on("producerclose", cleanup);
    consumer.on("close", cleanup);

    return { consumer, consumerId: consumer.id };
  }

  function closeClient(clientId) {
    for (const [transportId, meta] of Array.from(transports.entries())) {
      if (meta.clientId !== clientId) continue;
      closeTransport(transportId);
    }
    for (const [producerId, meta] of Array.from(producers.entries())) {
      if (meta.clientId !== clientId) continue;
      meta.producer.close();
      producers.delete(producerId);
    }
    for (const [consumerId, meta] of Array.from(consumers.entries())) {
      if (meta.clientId !== clientId) continue;
      meta.consumer.close();
      consumers.delete(consumerId);
    }
  }

  async function closeProducer(producerId) {
    const meta = producers.get(producerId);
    if (!meta) return false;
    meta.producer.close();
    return true;
  }

  async function closeConsumer(consumerId) {
    const meta = consumers.get(consumerId);
    if (!meta) return false;
    meta.consumer.close();
    return true;
  }

  function getRoomsOverview() {
    const overview = [];
    for (const ctx of rooms.values()) {
      overview.push({
        name: ctx.name,
        transports: ctx.transports.size,
        producers: ctx.producers.size,
        consumers: ctx.consumers.size,
        metrics: { ...ctx.metrics },
      });
    }
    return overview;
  }

  function getMetrics() {
    return {
      rooms: getRoomsOverview(),
      totals: {
        transports: transports.size,
        producers: producers.size,
        consumers: consumers.size,
      },
    };
  }

  return {
    createWorkers: ensureWorkers,
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
    on: emitter.on.bind(emitter),
    off: emitter.off
      ? emitter.off.bind(emitter)
      : emitter.removeListener.bind(emitter),
    once: emitter.once.bind(emitter),
  };
}

module.exports = { createSFUServer };
