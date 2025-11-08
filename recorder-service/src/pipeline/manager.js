// Pipeline manager: starts/stops GStreamer/FFmpeg pipelines
const { spawn } = require("child_process");
const path = require("path");

const activePipelines = new Map();

function startPipeline({ ip, rtpPort, codec, producerId, payloadType, ssrc }) {
  console.log("[Pipeline Manager] startPipeline called with:", {
    ip,
    rtpPort,
    codec,
    producerId,
    payloadType,
    ssrc,
  });
  console.log(
    `[Pipeline Manager] typeof payloadType: ${typeof payloadType}, value: ${payloadType}`
  );
  console.log(`[Pipeline Manager] typeof ssrc: ${typeof ssrc}, value: ${ssrc}`);
  console.log(
    `[Pipeline Manager] typeof rtpPort: ${typeof rtpPort}, value: ${rtpPort}`
  );
  console.log(
    `[Pipeline Manager] typeof codec: ${typeof codec}, value: ${codec}`
  );
  console.log(
    `[Pipeline Manager] typeof producerId: ${typeof producerId}, value: ${producerId}`
  );
  console.log(`[Pipeline Manager] typeof ip: ${typeof ip}, value: ${ip}`);
  // Use rtpPort parameter directly
  // Validate required parameters
  if (typeof payloadType === "undefined" || payloadType === null) {
    console.error(
      `[Pipeline Manager] ERROR: payloadType is missing or undefined for producer ${producerId}`
    );
    throw new Error("Missing payloadType");
  }
  if (typeof ssrc === "undefined" || ssrc === null) {
    console.error(
      `[Pipeline Manager] ERROR: ssrc is missing or undefined for producer ${producerId}`
    );
    throw new Error("Missing ssrc");
  }
  console.log("[Pipeline Manager] Parameter validation passed.");
  // Example: GStreamer pipeline for VP8/webm
  console.log("[Pipeline Manager] Preparing GStreamer pipeline...");
  const outputFile = path.join(
    __dirname,
    "../../recordings",
    `${producerId}-${Date.now()}.webm`
  );
  console.log(`[Pipeline Manager] Output file will be: ${outputFile}`);
  let gstCmd;
  let ssrcCaps =
    typeof ssrc !== "undefined" && ssrc !== null ? `, ssrc=${ssrc}` : "";
  console.log(`[Pipeline Manager] ssrcCaps: ${ssrcCaps}`);
  if (codec === "video") {
    console.log("[Pipeline Manager] Codec is video, using VP8 pipeline.");
    gstCmd =
      `gst-launch-1.0 -e -v ` +
      `udpsrc port=${rtpPort} caps="application/x-rtp, media=(string)video, encoding-name=(string)VP8, payload=${payloadType}${ssrcCaps}" ` +
      `! rtpjitterbuffer ` +
      `! rtpvp8depay ` +
      `! webmmux streamable=true ` +
      `! filesink location=\"${outputFile}\"`;
    console.log(`[Pipeline Manager] GStreamer command: ${gstCmd}`);
  } else {
    // Add audio or other codec support as needed
    console.error(`[Pipeline Manager] Unsupported codec: ${codec}`);
    throw new Error("Unsupported codec");
  }
  console.log(
    `[Pipeline Manager] Starting pipeline for producer ${producerId}`
  );
  console.log(`[Pipeline Manager] Command: ${gstCmd}`);
  const proc = spawn(gstCmd, { shell: true });
  console.log("[Pipeline Manager] GStreamer process spawned:", {
    pid: proc.pid,
  });
  activePipelines.set(producerId, { proc, outputFile });
  proc.stdout.on("data", (data) => {
    console.log(`[Pipeline Manager] GStreamer stdout: ${data}`);
  });
  proc.stderr.on("data", (data) => {
    console.error(`[Pipeline Manager] GStreamer error: ${data}`);
  });
  proc.on("exit", (code) => {
    console.log(
      `[Pipeline Manager] Pipeline for producer ${producerId} exited with code ${code}`
    );
    activePipelines.delete(producerId);
    if (code !== 0) {
      console.error(
        `[Pipeline Manager] GStreamer exited with non-zero code: ${code}`
      );
    }
  });
  proc.on("close", (code, signal) => {
    console.log(
      `[Pipeline Manager] GStreamer process closed. Code: ${code}, Signal: ${signal}`
    );
  });
  proc.on("error", (err) => {
    console.error(`[Pipeline Manager] GStreamer process error:`, err);
  });
  return { outputFile };
}

function stopPipeline({ producerId }) {
  const entry = activePipelines.get(producerId);
  if (entry) {
    console.log(
      `[Pipeline Manager] Stopping pipeline for producer ${producerId}`
    );
    // Try SIGINT first, then SIGTERM if still running
    entry.proc.kill("SIGINT");
    setTimeout(() => {
      if (!entry.proc.killed) {
        console.log(
          `[Pipeline Manager] SIGINT did not terminate process, sending SIGTERM...`
        );
        entry.proc.kill("SIGTERM");
      }
    }, 2000);
    activePipelines.delete(producerId);
  } else {
    console.warn(
      `[Pipeline Manager] No active pipeline found for producer ${producerId}`
    );
  }
}

module.exports = { startPipeline, stopPipeline };
