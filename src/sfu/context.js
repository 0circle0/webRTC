const os = require("os");
const { EventEmitter } = require("events");

const DEFAULT_MEDIA_CODECS = [
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
];

function createSfuContext({ mediasoup, opts = {} }) {
  if (!mediasoup) throw new Error("mediasoup module is required");

  const options = {
    logLevel: opts.logLevel || "warn",
    rtcMinPort: opts.rtcMinPort,
    rtcMaxPort: opts.rtcMaxPort,
    logTags: opts.logTags || ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    mediaCodecs: opts.mediaCodecs || DEFAULT_MEDIA_CODECS,
    enableUdp: opts.enableUdp !== false,
    enableTcp: opts.enableTcp !== false,
    preferUdp: opts.preferUdp !== false,
    listenIps: opts.listenIps,
    numWorkers: opts.numWorkers || Math.max(1, os.cpus().length - 1),
  };

  const state = {
    workers: [],
    workerIndex: 0,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
    rooms: new Map(),
  };

  const emitter = new EventEmitter();

  async function ensureWorkers() {
    if (state.workers.length) return state.workers;
    for (let i = 0; i < options.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: options.logLevel,
        rtcMinPort: options.rtcMinPort,
        rtcMaxPort: options.rtcMaxPort,
        logTags: options.logTags,
      });
      worker.on("died", () => {
        console.error("mediasoup worker died, exiting");
        process.exit(1);
      });
      state.workers.push(worker);
    }
    console.log(`Created ${state.workers.length} mediasoup worker(s)`);
    return state.workers;
  }

  async function getWorker() {
    await ensureWorkers();
    const worker = state.workers[state.workerIndex % state.workers.length];
    state.workerIndex = (state.workerIndex + 1) % state.workers.length;
    return worker;
  }

  async function ensureRoomContext(roomName) {
    if (state.rooms.has(roomName)) return state.rooms.get(roomName);
    const worker = await getWorker();
    const router = await worker.createRouter({
      mediaCodecs: options.mediaCodecs,
    });
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
    state.rooms.set(roomName, ctx);
    return ctx;
  }

  function getRoom(roomName) {
    return state.rooms.get(roomName) || null;
  }

  function registerTransport(transport, meta) {
    state.transports.set(transport.id, { transport, ...meta });
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) roomCtx.transports.add(transport.id);
  }

  function unregisterTransport(transportId) {
    const meta = state.transports.get(transportId);
    if (!meta) return null;
    state.transports.delete(transportId);
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) roomCtx.transports.delete(transportId);
    return meta;
  }

  function getTransport(transportId) {
    return state.transports.get(transportId) || null;
  }

  function registerProducer(producer, meta) {
    state.producers.set(producer.id, { producer, ...meta });
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) {
      roomCtx.producers.add(producer.id);
      roomCtx.metrics.totalProducers += 1;
    }
  }

  function unregisterProducer(producerId) {
    const meta = state.producers.get(producerId);
    if (!meta) return null;
    state.producers.delete(producerId);
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) roomCtx.producers.delete(producerId);
    return meta;
  }

  function getProducer(producerId) {
    return state.producers.get(producerId) || null;
  }

  function registerConsumer(consumer, meta) {
    state.consumers.set(consumer.id, { consumer, ...meta });
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) {
      roomCtx.consumers.add(consumer.id);
      roomCtx.metrics.totalConsumers += 1;
    }
  }

  function unregisterConsumer(consumerId) {
    const meta = state.consumers.get(consumerId);
    if (!meta) return null;
    state.consumers.delete(consumerId);
    const roomCtx = state.rooms.get(meta.roomName);
    if (roomCtx) roomCtx.consumers.delete(consumerId);
    return meta;
  }

  function getConsumer(consumerId) {
    return state.consumers.get(consumerId) || null;
  }

  function getRoomsOverview() {
    const overview = [];
    for (const roomCtx of state.rooms.values()) {
      overview.push({
        name: roomCtx.name,
        transports: roomCtx.transports.size,
        producers: roomCtx.producers.size,
        consumers: roomCtx.consumers.size,
        metrics: { ...roomCtx.metrics },
      });
    }
    return overview;
  }

  function getMetrics() {
    return {
      rooms: getRoomsOverview(),
      totals: {
        transports: state.transports.size,
        producers: state.producers.size,
        consumers: state.consumers.size,
      },
    };
  }

  function closeClientResources(clientId) {
    for (const [transportId, meta] of Array.from(state.transports.entries())) {
      if (meta.clientId !== clientId) continue;
      meta.transport.close();
    }
    for (const [producerId, meta] of Array.from(state.producers.entries())) {
      if (meta.clientId !== clientId) continue;
      meta.producer.close();
    }
    for (const [consumerId, meta] of Array.from(state.consumers.entries())) {
      if (meta.clientId !== clientId) continue;
      meta.consumer.close();
    }
  }

  return {
    mediasoup,
    options,
    emitter,
    state,
    ensureWorkers,
    getWorker,
    ensureRoomContext,
    getRoom,
    registerTransport,
    unregisterTransport,
    getTransport,
    registerProducer,
    unregisterProducer,
    getProducer,
    registerConsumer,
    unregisterConsumer,
    getConsumer,
    getRoomsOverview,
    getMetrics,
    closeClientResources,
  };
}

module.exports = { createSfuContext };
