// API server for recording control
const express = require("express");
const { startPipeline, stopPipeline } = require("../pipeline/manager");

function startApiServer(port = 4000) {
  const app = express();
  app.use(express.json());

  // Start recording
  app.post("/start", async (req, res) => {
    console.log(`[Recorder API] /start called with:`, req.body);
    try {
      const {
        ip,
        port: rtpPort,
        codec,
        producerId,
        payloadType,
        ssrc,
      } = req.body;
      const result = await startPipeline({
        ip,
        rtpPort,
        codec,
        producerId,
        payloadType,
        ssrc,
      });
      console.log(
        `[Recorder API] Pipeline started for producer ${producerId}, output: ${result.outputFile}`
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(`[Recorder API] Failed to start pipeline:`, err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Stop recording
  app.post("/stop", async (req, res) => {
    console.log(`[Recorder API] /stop called with:`, req.body);
    try {
      const { producerId } = req.body;
      await stopPipeline({ producerId });
      console.log(`[Recorder API] Pipeline stopped for producer ${producerId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[Recorder API] Failed to stop pipeline:`, err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`Recorder API listening on port ${port}`);
  });
}

module.exports = { startApiServer };
