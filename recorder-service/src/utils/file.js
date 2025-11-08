// Utility functions for recording microservice

function getOutputFileName(producerId, ext = "webm") {
  const ts = Date.now();
  return `${producerId}-${ts}.${ext}`;
}

module.exports = { getOutputFileName };
