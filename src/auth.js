// Simple token validator for demo purposes with optional file persistence.
// In production replace with real auth (JWT, OAuth, etc.).

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const tokenFile = path.join(dataDir, "tokens.json");

const tokens = new Map();

function ensureDataDir() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    // if we can't create data dir, keep running with in-memory only
    console.warn("auth: failed to ensure data directory", err.message);
  }
}

function loadTokens() {
  try {
    if (!fs.existsSync(tokenFile)) return;
    const raw = fs.readFileSync(tokenFile, "utf8");
    const obj = JSON.parse(raw || "{}");
    Object.entries(obj).forEach(([token, user]) => tokens.set(token, user));
  } catch (err) {
    console.warn("auth: failed to load tokens file", err.message);
  }
}

function saveTokens() {
  try {
    ensureDataDir();
    const obj = {};
    for (const [token, user] of tokens.entries()) obj[token] = user;
    fs.writeFileSync(tokenFile, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.warn("auth: failed to save tokens file", err.message);
  }
}

// seed with a demo token if none exists
function seedDemoToken() {
  if (tokens.size === 0) {
    tokens.set("demo-token", { id: "demo-user", name: "Demo User" });
    saveTokens();
  }
}

function validateToken(token) {
  if (!token) return null;
  return tokens.get(token) || null;
}

function addToken(token, user) {
  if (!token || !user) throw new Error("token and user required");
  tokens.set(token, user);
  saveTokens();
  return true;
}

// initialize
loadTokens();
seedDemoToken();

module.exports = { validateToken, tokens, addToken, tokenFile };
