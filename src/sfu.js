// mediasoup SFU facade. Loads mediasoup, wires modular state/operations, and
// exposes the same public API the rest of the server expects.

const { createSfuContext } = require("./sfu/context");
const { createSfuOperations } = require("./sfu/operations");

function loadMediasoup() {
  try {
    return require("mediasoup");
  } catch (err) {
    console.error("mediasoup not installed. Required for server startup. Run:");
    console.error("  npm install --save mediasoup");
    console.error(
      "See https://mediasoup.org/ for installation notes (native deps)"
    );
    throw err;
  }
}

function createSFUServer(opts = {}) {
  const mediasoup = loadMediasoup();
  const context = createSfuContext({ mediasoup, opts });
  const operations = createSfuOperations(context);

  const emitter = context.emitter;

  return {
    createWorkers: context.ensureWorkers,
    createWebRtcTransport: operations.createWebRtcTransport,
    connectTransport: operations.connectTransport,
    closeTransport: operations.closeTransport,
    createProducer: operations.createProducer,
    createConsumer: operations.createConsumer,
    closeClient: operations.closeClient,
    closeProducer: operations.closeProducer,
    closeConsumer: operations.closeConsumer,
    getRoomsOverview: operations.getRoomsOverview,
    getMetrics: operations.getMetrics,
    startRecording: operations.startRecording,
    stopRecording: operations.stopRecording,
    on: emitter.on.bind(emitter),
    off: emitter.off
      ? emitter.off.bind(emitter)
      : emitter.removeListener.bind(emitter),
    once: emitter.once.bind(emitter),
  };
}

module.exports = { createSFUServer };
