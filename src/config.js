// Load environment variables from .env before reading configuration.
require("dotenv").config();

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function parseJSONEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`${name} is not valid JSON; ignoring`);
    return null;
  }
}

function getIceServers() {
  const fromJson = parseJSONEnv("ICE_SERVERS");
  if (Array.isArray(fromJson) && fromJson.length) return fromJson;

  const turnHost = process.env.TURN_HOST;
  if (!turnHost) return DEFAULT_ICE_SERVERS;

  const url = new URL("turn://" + turnHost);
  if (process.env.TURN_PORT) url.port = process.env.TURN_PORT;
  const urls = [url.toString()];
  const username = process.env.TURN_USERNAME || undefined;
  const credential =
    process.env.TURN_PASSWORD || process.env.TURN_SECRET || undefined;
  return [{ urls, username, credential }];
}

function getMaxVideoPerRoom() {
  const raw = process.env.MAX_VIDEO_PER_ROOM;
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getRoomDefaults() {
  return {
    maxVideoProducers: getMaxVideoPerRoom(),
    allowObservers: process.env.ALLOW_OBSERVERS !== "0",
    maxObservers: process.env.MAX_OBSERVERS
      ? parseInt(process.env.MAX_OBSERVERS, 10) || 0
      : 0,
  };
}

function getListenIps() {
  const parsed = parseJSONEnv("SFU_LISTEN_IPS");
  if (Array.isArray(parsed) && parsed.length) return parsed;
  const bindIp = process.env.SFU_BIND_IP || "127.0.0.1";
  let announcedIp = process.env.PUBLIC_IP || process.env.SFU_ANNOUNCED_IP;

  if (!announcedIp) {
    // For local development default to loopback which works for Chrome/Firefox
    announcedIp = "127.0.0.1";
  }

  return [{ ip: bindIp, announcedIp }];
}

module.exports = {
  getIceServers,
  getMaxVideoPerRoom,
  getRoomDefaults,
  getListenIps,
};
