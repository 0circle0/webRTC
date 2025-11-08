// HTTP client for SFU-to-recorder microservice
const fetch = require("node-fetch");

const RECORDER_API_URL =
  process.env.RECORDER_API_URL || "http://localhost:4000";

async function recorderStart({ ip, port, codec, producerId }) {
  // Accept additional params: payloadType, ssrc
  const res = await fetch(`${RECORDER_API_URL}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ip,
      port,
      codec,
      producerId,
      payloadType: arguments[0].payloadType,
      ssrc: arguments[0].ssrc,
    }),
  });
  if (!res.ok) throw new Error(`Recorder start failed: ${await res.text()}`);
  return res.json();
}

async function recorderStop({ producerId }) {
  const res = await fetch(`${RECORDER_API_URL}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ producerId }),
  });
  if (!res.ok) throw new Error(`Recorder stop failed: ${await res.text()}`);
  return res.json();
}

module.exports = { recorderStart, recorderStop };
