const WebSocket = require("ws");

function createClient(url, opts = {}) {
  const reconnectInterval = opts.reconnectInterval || 1000;
  let ws;
  let closedByUser = false;
  const handlers = {};

  function emitLocal(event, data) {
    (handlers[event] || []).forEach((h) => h(data));
  }

  function connect() {
    ws = new WebSocket(url);

    ws.on("open", () => emitLocal("open"));

    ws.on("message", (d) => {
      let msg;
      try {
        msg = JSON.parse(d);
      } catch (e) {
        return;
      }
      emitLocal(msg.type, msg);
    });

    ws.on("close", () => {
      emitLocal("close");
      if (!closedByUser) {
        setTimeout(connect, reconnectInterval);
      }
    });

    ws.on("error", (err) => emitLocal("error", err));
  }

  connect();

  return {
    emit(event, data = {}) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ type: event }, data)));
      }
    },
    on(event, fn) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(fn);
    },
    join(room) {
      this.emit("join", { room });
    },
    leave(room) {
      this.emit("leaveRoom", { room });
    },
    close() {
      closedByUser = true;
      if (ws) ws.close();
    },
    _raw() {
      return ws;
    },
  };
}

module.exports = { createClient };
