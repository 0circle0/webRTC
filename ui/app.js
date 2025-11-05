import { Device } from "mediasoup-client";

(function () {
  const wsInput = document.getElementById("wsUrl");
  const roomInput = document.getElementById("room");
  const tokenInput = document.getElementById("token");
  const joinForm = document.getElementById("joinForm");
  const joinBtn = document.getElementById("joinBtn");
  const leaveBtn = document.getElementById("leaveBtn");
  const statusEl = document.getElementById("status");
  const localVideo = document.getElementById("localVideo");
  const remoteVideosEl = document.getElementById("remoteVideos");
  const logEl = document.getElementById("log");

  wsInput.value = `ws://${location.hostname || "localhost"}:3000`;

  const state = {
    room: null,
    token: null,
    ws: null,
    id: null,
    localStream: null,
    device: null,
    deviceLoaded: false,
    sendTransport: null,
    recvTransport: null,
    localProducers: new Map(),
    consumers: new Map(),
    producerToConsumer: new Map(),
    pendingTransportRequests: new Map(),
    pendingConnectRequests: new Map(),
    pendingProduceRequests: new Map(),
    pendingConsumeRequests: new Map(),
    subscribedProducers: new Set(),
    pendingRemoteProducers: [],
  };

  function log(message) {
    const time = new Date().toLocaleTimeString();
    logEl.textContent += `[${time}] ${message}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function randomId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function send(message) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      log("Cannot send message: socket not open");
      return;
    }
    state.ws.send(JSON.stringify(message));
  }

  async function startLocalMedia() {
    if (state.localStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      state.localStream = stream;
      localVideo.srcObject = stream;
      log("Local media captured");
    } catch (err) {
      log(`getUserMedia failed: ${err.message}`);
      throw err;
    }
  }

  function removeConsumerEntry(consumerId) {
    const entry = state.consumers.get(consumerId);
    if (!entry) return null;
    const { consumer, element } = entry;
    if (element && element.parentNode) {
      element.remove();
    }
    log(
      `Removed remote consumer ${consumerId}; remaining=${remoteVideosEl.childElementCount}`
    );
    state.consumers.delete(consumerId);
    state.producerToConsumer.delete(consumer.producerId);
    state.subscribedProducers.delete(consumer.producerId);
    if (!consumer.closed) {
      try {
        consumer.close();
      } catch (_) {
        /* ignore */
      }
    }
    return entry;
  }

  function attachRemoteStream(consumer) {
    const isAudio = consumer.kind === "audio";
    const element = document.createElement(isAudio ? "audio" : "video");
    element.autoplay = true;
    element.playsInline = true;
    element.dataset.consumerId = consumer.id;
    if (isAudio) {
      element.classList.add("remote-audio");
      element.muted = false;
      element.defaultMuted = false;
    }
    element.preload = "auto";
    if (!isAudio) {
      element.classList.add("remote-video");
      element.muted = false;
      element.defaultMuted = false;
      element.autoplay = true;
    }

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    log(
      `Preparing remote ${consumer.kind} element: consumer=${consumer.id}, readyState=${consumer.producerPaused}`
    );
    element.srcObject = stream;
    remoteVideosEl.appendChild(element);

    const attemptPlayback = () => {
      log(
        `Attempting playback for consumer ${consumer.id}; muted=${consumer.track.muted}`
      );
      if (element.srcObject !== stream) {
        element.srcObject = stream;
      }
      const playPromise = element.play?.();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          log(
            `Autoplay blocked for remote ${consumer.kind}; user gesture required.`
          );
          element.controls = true;
          if (isAudio) {
            element.classList.remove("remote-audio");
          }
        });
      }
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            if (element.paused) {
              element.play().catch(() => {});
            }
          })
          .catch(() => {});
      }
    };

    if (consumer.track.muted) {
      const handleUnmute = () => {
        log(`Remote ${consumer.kind} track unmuted (${consumer.id})`);
        consumer.track.removeEventListener("unmute", handleUnmute);
        attemptPlayback();
      };
      consumer.track.addEventListener("unmute", handleUnmute);
    } else {
      attemptPlayback();
    }

    element.addEventListener("loadeddata", () => {
      log(`Remote ${consumer.kind} element loaded (${consumer.id})`);
    });
    element.addEventListener("error", (evt) => {
      log(
        `Remote ${consumer.kind} element error (${consumer.id}): ${
          evt?.message || evt?.type || "unknown"
        }`
      );
    });

    const entry = { consumer, element, isAudio };
    state.consumers.set(consumer.id, entry);
    state.producerToConsumer.set(consumer.producerId, entry);
    log(
      `Attached remote ${consumer.kind} from producer ${consumer.producerId}`
    );
    log(`Remote media elements: ${remoteVideosEl.childElementCount}`);

    const teardown = () => {
      removeConsumerEntry(consumer.id);
    };
    consumer.on("trackended", teardown);
    consumer.on("transportclose", teardown);
    consumer.on("producerpause", () => {
      log(`Remote ${consumer.kind} paused (${consumer.id})`);
    });
    consumer.on("producerresume", () => {
      log(`Remote ${consumer.kind} resumed (${consumer.id})`);
      attemptPlayback();
    });
  }

  function cleanupRemoteConsumers() {
    for (const consumerId of Array.from(state.consumers.keys())) {
      removeConsumerEntry(consumerId);
    }
    state.producerToConsumer.clear();
    remoteVideosEl.innerHTML = "";
    state.subscribedProducers.clear();
    state.pendingRemoteProducers = [];
  }

  function resetState() {
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        track.stop();
      }
      state.localStream = null;
      localVideo.srcObject = null;
    }
    if (state.sendTransport) {
      try {
        state.sendTransport.close();
      } catch (_) {}
      state.sendTransport = null;
    }
    if (state.recvTransport) {
      try {
        state.recvTransport.close();
      } catch (_) {}
      state.recvTransport = null;
    }
    state.device = null;
    state.deviceLoaded = false;
    state.localProducers.clear();
    cleanupRemoteConsumers();
    state.pendingTransportRequests.clear();
    state.pendingConnectRequests.clear();
    state.pendingProduceRequests.clear();
    state.pendingConsumeRequests.clear();
    state.room = null;
    state.token = null;
    state.id = null;
    setStatus("Disconnected");
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
  }

  function requestTransport(direction) {
    if (direction === "send" && state.sendTransport) {
      return Promise.resolve(state.sendTransport);
    }
    if (direction === "recv" && state.recvTransport) {
      return Promise.resolve(state.recvTransport);
    }
    const requestId = randomId();
    const promise = new Promise((resolve, reject) => {
      state.pendingTransportRequests.set(requestId, {
        direction,
        resolve,
        reject,
      });
    });
    send({
      type: "sfu.createTransport",
      room: state.room,
      direction,
      requestId,
    });
    return promise;
  }

  function setupSendTransport(transport) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      const requestId = randomId();
      state.pendingConnectRequests.set(requestId, { callback, errback });
      send({
        type: "sfu.connectTransport",
        transportId: transport.id,
        dtlsParameters,
        requestId,
        room: state.room,
      });
    });

    transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
      const requestId = randomId();
      state.pendingProduceRequests.set(requestId, { callback, errback });
      send({
        type: "sfu.produce",
        transportId: transport.id,
        kind,
        rtpParameters,
        room: state.room,
        requestId,
      });
    });

    transport.on("connectionstatechange", (stateStr) => {
      log(`Send transport state: ${stateStr}`);
    });
  }

  function setupRecvTransport(transport) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      const requestId = randomId();
      state.pendingConnectRequests.set(requestId, { callback, errback });
      send({
        type: "sfu.connectTransport",
        transportId: transport.id,
        dtlsParameters,
        requestId,
        room: state.room,
      });
    });

    transport.on("connectionstatechange", (stateStr) => {
      log(`Recv transport state: ${stateStr}`);
    });
  }

  async function ensureDeviceLoaded(routerRtpCapabilities) {
    if (!state.device) {
      state.device = new Device();
    }
    if (state.deviceLoaded) return;
    await state.device.load({ routerRtpCapabilities });
    state.deviceLoaded = true;
    log("mediasoup device initialized");
    await drainPendingConsumers();
  }

  async function handleTransportCreated(msg) {
    let requestKey = null;
    let pending = null;
    if (msg.requestId && state.pendingTransportRequests.has(msg.requestId)) {
      requestKey = msg.requestId;
      pending = state.pendingTransportRequests.get(msg.requestId);
    } else {
      for (const [key, entry] of state.pendingTransportRequests) {
        if (entry.direction === msg.direction) {
          requestKey = key;
          pending = entry;
          break;
        }
      }
    }

    const direction = pending ? pending.direction : msg.direction;
    await ensureDeviceLoaded(msg.routerRtpCapabilities);

    const baseOptions = {
      id: msg.transportId,
      iceParameters: msg.iceParameters,
      iceCandidates: msg.iceCandidates,
      dtlsParameters: msg.dtlsParameters,
      iceServers: msg.iceServers,
    };

    if (direction === "send") {
      const transport = state.device.createSendTransport(baseOptions);
      setupSendTransport(transport);
      state.sendTransport = transport;
      if (pending) pending.resolve(transport);
      if (requestKey) state.pendingTransportRequests.delete(requestKey);
      if (state.localStream) {
        await produceLocalTracks();
      }
    } else {
      const transport = state.device.createRecvTransport(baseOptions);
      setupRecvTransport(transport);
      state.recvTransport = transport;
      if (pending) pending.resolve(transport);
      if (requestKey) state.pendingTransportRequests.delete(requestKey);
      await drainPendingConsumers();
    }
  }

  async function produceLocalTracks() {
    if (!state.sendTransport || !state.localStream) return;
    const tracks = state.localStream.getTracks();
    for (const track of tracks) {
      if (state.localProducers.has(track.id)) continue;
      try {
        const producer = await state.sendTransport.produce({ track });
        state.localProducers.set(track.id, producer);
        producer.on("transportclose", () => {
          state.localProducers.delete(track.id);
        });
        producer.on("close", () => {
          state.localProducers.delete(track.id);
        });
        log(`Producing local ${track.kind}`);
      } catch (err) {
        log(`Failed to produce ${track.kind}: ${err.message}`);
      }
    }
  }

  function requestConsume(transport, producerId) {
    const requestId = randomId();
    const promise = new Promise((resolve, reject) => {
      state.pendingConsumeRequests.set(requestId, {
        resolve,
        reject,
        producerId,
      });
    });
    send({
      type: "sfu.consume",
      room: state.room,
      transportId: transport.id,
      producerId,
      rtpCapabilities: state.device.rtpCapabilities,
      requestId,
    });
    return promise;
  }

  async function consumeProducer(producerId) {
    if (!state.deviceLoaded) {
      if (!state.pendingRemoteProducers.includes(producerId)) {
        log("Device not ready, queueing producer");
        state.pendingRemoteProducers.push(producerId);
      }
      return;
    }
    if (state.subscribedProducers.has(producerId)) return;
    state.subscribedProducers.add(producerId);
    try {
      const transport = await requestTransport("recv");
      const data = await requestConsume(transport, producerId);
      const consumer = await transport.consume({
        id: data.consumerId,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      });
      await consumer.resume();
      attachRemoteStream(consumer);
      if (
        consumer.kind === "video" &&
        typeof consumer.requestKeyFrame === "function"
      ) {
        try {
          await consumer.requestKeyFrame();
          log(`Requested keyframe for producer ${producerId}`);
        } catch (err) {
          log(`requestKeyFrame failed: ${err.message}`);
        }
      }
    } catch (err) {
      log(`Consume failed: ${err.message}`);
      state.subscribedProducers.delete(producerId);
      if (!state.pendingRemoteProducers.includes(producerId)) {
        state.pendingRemoteProducers.push(producerId);
      }
    }
  }

  async function drainPendingConsumers() {
    if (!state.recvTransport || !state.deviceLoaded) return;
    const queue = state.pendingRemoteProducers.splice(0);
    for (const producerId of queue) {
      await consumeProducer(producerId);
    }
  }

  function handleTransportConnected(msg) {
    let requestKey = msg.requestId;
    let pending = requestKey
      ? state.pendingConnectRequests.get(requestKey)
      : null;
    if (!pending) {
      const iter = state.pendingConnectRequests.entries().next();
      if (!iter.done) {
        requestKey = iter.value[0];
        pending = iter.value[1];
      }
    }
    if (!pending) return;
    state.pendingConnectRequests.delete(requestKey);
    try {
      pending.callback();
    } catch (err) {
      log(`connect callback error: ${err.message}`);
    }
  }

  function handleProduced(msg) {
    let requestKey = msg.requestId;
    let pending = requestKey
      ? state.pendingProduceRequests.get(requestKey)
      : null;
    if (!pending) {
      const iter = state.pendingProduceRequests.entries().next();
      if (!iter.done) {
        requestKey = iter.value[0];
        pending = iter.value[1];
      }
    }
    if (!pending) return;
    state.pendingProduceRequests.delete(requestKey);
    try {
      pending.callback({ id: msg.producerId });
    } catch (err) {
      log(`produce callback error: ${err.message}`);
    }
  }

  function handleConsumed(msg) {
    let requestKey = msg.requestId;
    let pending = requestKey
      ? state.pendingConsumeRequests.get(requestKey)
      : null;
    if (!pending) {
      const iter = state.pendingConsumeRequests.entries().next();
      if (!iter.done) {
        requestKey = iter.value[0];
        pending = iter.value[1];
      }
    }
    if (!pending) return;
    state.pendingConsumeRequests.delete(requestKey);
    pending.resolve(msg);
  }

  function handleNewProducer(msg) {
    consumeProducer(msg.producerId);
  }

  function handleProducerClosed(msg) {
    const entry = state.producerToConsumer.get(msg.producerId);
    if (!entry) return;
    removeConsumerEntry(entry.consumer.id);
    log(`Producer ${msg.producerId} closed`);
  }

  function handleProducersList(msg) {
    log(
      `Received producers list (${(msg.producers || []).length}) for room ${
        msg.room
      }`
    );
    for (const producer of msg.producers || []) {
      consumeProducer(producer.producerId);
    }
  }

  function handleMemberJoined(msg) {
    log(`Member joined: ${msg.id} role=${msg.role}`);
  }

  function handleMemberLeft(msg) {
    log(`Member left: ${msg.id}`);
  }

  function handleMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      log(`Failed to parse message: ${err.message}`);
      return;
    }

    switch (payload.type) {
      case "id":
        state.id = payload.id;
        log(`Assigned client id ${state.id}`);
        break;
      case "joined":
        log(`Joined room ${payload.room} as ${payload.role}`);
        setStatus(`In room ${payload.room}`);
        send({ type: "sfu.listProducers", room: state.room });
        break;
      case "sfu.transportCreated":
        handleTransportCreated(payload).catch((err) => {
          log(`Transport setup failed: ${err.message}`);
        });
        break;
      case "sfu.transportConnected":
        handleTransportConnected(payload);
        break;
      case "sfu.produced":
        handleProduced(payload);
        break;
      case "sfu.consumed":
        handleConsumed(payload);
        break;
      case "sfu.newProducer":
        handleNewProducer(payload);
        break;
      case "sfu.producers":
        handleProducersList(payload);
        break;
      case "sfu.producerClosed":
        handleProducerClosed(payload);
        break;
      case "member-joined":
        handleMemberJoined(payload);
        break;
      case "member-left":
        handleMemberLeft(payload);
        break;
      case "error":
        log(`Error: ${payload.message}`);
        break;
      default:
        log(`Unhandled message ${payload.type || "unknown"}`);
    }
  }

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.ws) {
      log("Already connected; leave first.");
      return;
    }
    const room = roomInput.value.trim();
    if (!room) {
      log("Room name required");
      return;
    }
    const wsUrl =
      wsInput.value.trim() || `ws://${location.hostname || "localhost"}:3000`;
    const token = tokenInput.value.trim();
    try {
      await startLocalMedia();
    } catch (err) {
      log("Cannot continue without local media access.");
      return;
    }

    state.room = room;
    state.token = token || null;
    const url = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
    const ws = new WebSocket(url);
    state.ws = ws;
    setStatus("Connecting...");
    joinBtn.disabled = true;
    leaveBtn.disabled = false;

    ws.addEventListener("open", () => {
      log("WebSocket connected");
      setStatus("Connected - joining room");
      remoteVideosEl.innerHTML = "";
      state.consumers.clear();
      state.producerToConsumer.clear();
      state.subscribedProducers.clear();
      send({ type: "join", room, role: "publisher" });
      requestTransport("send").catch((err) => {
        log(`Failed to request send transport: ${err.message}`);
      });
      requestTransport("recv").catch((err) => {
        log(`Failed to request recv transport: ${err.message}`);
      });
    });
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", () => {
      log("WebSocket closed");
      resetState();
    });
    ws.addEventListener("error", (err) => {
      log(`WebSocket error: ${err.message || err}`);
    });
  });

  leaveBtn.addEventListener("click", () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      if (state.room) {
        send({ type: "leaveRoom", room: state.room });
      }
      state.ws.close();
    } else {
      resetState();
    }
  });
})();
