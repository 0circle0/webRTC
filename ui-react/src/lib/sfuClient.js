import { Device } from "mediasoup-client";

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function ensureWsUrl(raw) {
  if (!raw) {
    const { hostname } = window.location;
    return `ws://${hostname || "localhost"}:3000`;
  }
  return raw;
}

export class SFUClient extends EventTarget {
  constructor() {
    super();
    this.state = {
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
      producerOwners: new Map(),
    };
  }

  log(message) {
    this.dispatchEvent(new CustomEvent("log", { detail: message }));
  }

  setStatus(text) {
    this.dispatchEvent(new CustomEvent("status", { detail: text }));
  }

  async join({ wsUrl, room, token } = {}) {
    if (this.state.ws) {
      throw new Error("Already connected");
    }
    if (!room) {
      throw new Error("Room is required");
    }

    const resolvedWsUrl = ensureWsUrl(wsUrl);
    this.state.room = room;
    this.state.token = token || null;
    const url = token
      ? `${resolvedWsUrl}?token=${encodeURIComponent(token)}`
      : resolvedWsUrl;

    const ws = new WebSocket(url);
    this.state.ws = ws;
    this.setStatus("Connecting…");
    this.log(`Connecting to ${url}`);

    ws.addEventListener("message", this.#handleMessage);
    ws.addEventListener("close", this.#handleSocketClose);
    ws.addEventListener("error", this.#handleSocketError);

    ws.addEventListener("open", async () => {
      try {
        const stream = await this.#startLocalMedia();
        this.dispatchEvent(
          new CustomEvent("local-stream", { detail: { stream } })
        );
      } catch (err) {
        this.log(`Local media failed: ${err.message}`);
        this.dispatchEvent(
          new CustomEvent("error", { detail: err.message || String(err) })
        );
        ws.close();
        return;
      }

      this.setStatus("Connected – joining room");
      this.log("WebSocket connected; joining room");
      this.#send({ type: "join", room, role: "publisher" });

      try {
        await this.#requestTransport("send");
      } catch (err) {
        this.log(`Failed to create send transport: ${err.message}`);
      }

      try {
        await this.#requestTransport("recv");
      } catch (err) {
        this.log(`Failed to create recv transport: ${err.message}`);
      }
    });

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve(this.state.localStream);
      };
      const onError = (event) => {
        cleanup();
        reject(event.error || new Error("WebSocket failed"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }

  async leave() {
    if (this.state.ws && this.state.ws.readyState === WebSocket.OPEN) {
      if (this.state.room) {
        this.#send({ type: "leaveRoom", room: this.state.room });
      }
      this.state.ws.close();
    }
    this.#resetState();
  }

  async #startLocalMedia() {
    if (this.state.localStream) return this.state.localStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    this.state.localStream = stream;
    this.log("Local media captured");
    return stream;
  }

  #send(message) {
    if (!this.state.ws || this.state.ws.readyState !== WebSocket.OPEN) {
      this.log("Cannot send message: socket not open");
      return;
    }
    this.state.ws.send(JSON.stringify(message));
  }

  async #requestTransport(direction) {
    if (direction === "send" && this.state.sendTransport) {
      return this.state.sendTransport;
    }
    if (direction === "recv" && this.state.recvTransport) {
      return this.state.recvTransport;
    }
    const requestId = randomId();
    const promise = new Promise((resolve, reject) => {
      this.state.pendingTransportRequests.set(requestId, {
        direction,
        resolve,
        reject,
      });
    });
    this.#send({
      type: "sfu.createTransport",
      room: this.state.room,
      direction,
      requestId,
    });
    return promise;
  }

  async #ensureDeviceLoaded(routerRtpCapabilities) {
    if (!this.state.device) {
      this.state.device = new Device();
    }
    if (this.state.deviceLoaded) return;
    await this.state.device.load({ routerRtpCapabilities });
    this.state.deviceLoaded = true;
    this.log("mediasoup device initialized");
    await this.#drainPendingConsumers();
  }

  #setupSendTransport(transport) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      const requestId = randomId();
      this.state.pendingConnectRequests.set(requestId, {
        callback,
        errback,
      });
      this.#send({
        type: "sfu.connectTransport",
        transportId: transport.id,
        dtlsParameters,
        requestId,
        room: this.state.room,
      });
    });

    transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
      const requestId = randomId();
      this.state.pendingProduceRequests.set(requestId, {
        callback,
        errback,
      });
      this.#send({
        type: "sfu.produce",
        transportId: transport.id,
        kind,
        rtpParameters,
        room: this.state.room,
        requestId,
      });
    });

    transport.on("connectionstatechange", (state) => {
      this.log(`Send transport state: ${state}`);
    });
  }

  #setupRecvTransport(transport) {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      const requestId = randomId();
      this.state.pendingConnectRequests.set(requestId, {
        callback,
        errback,
      });
      this.#send({
        type: "sfu.connectTransport",
        transportId: transport.id,
        dtlsParameters,
        requestId,
        room: this.state.room,
      });
    });

    transport.on("connectionstatechange", (state) => {
      this.log(`Recv transport state: ${state}`);
    });
  }

  async #handleTransportCreated(msg) {
    const { requestId } = msg;
    let key = requestId || null;
    let pending = null;
    if (key && this.state.pendingTransportRequests.has(key)) {
      pending = this.state.pendingTransportRequests.get(key);
    } else {
      for (const [mapKey, entry] of this.state.pendingTransportRequests) {
        if (entry.direction === msg.direction) {
          key = mapKey;
          pending = entry;
          break;
        }
      }
    }

    await this.#ensureDeviceLoaded(msg.routerRtpCapabilities);

    const baseOptions = {
      id: msg.transportId,
      iceParameters: msg.iceParameters,
      iceCandidates: msg.iceCandidates,
      dtlsParameters: msg.dtlsParameters,
      iceServers: msg.iceServers,
    };

    if (msg.direction === "send") {
      const transport = this.state.device.createSendTransport(baseOptions);
      this.#setupSendTransport(transport);
      this.state.sendTransport = transport;
      pending?.resolve(transport);
      if (key) this.state.pendingTransportRequests.delete(key);
      await this.#produceLocalTracks();
    } else {
      const transport = this.state.device.createRecvTransport(baseOptions);
      this.#setupRecvTransport(transport);
      this.state.recvTransport = transport;
      pending?.resolve(transport);
      if (key) this.state.pendingTransportRequests.delete(key);
      await this.#drainPendingConsumers();
    }
  }

  async #produceLocalTracks() {
    if (!this.state.sendTransport || !this.state.localStream) return;
    const tracks = this.state.localStream.getTracks();
    for (const track of tracks) {
      if (this.state.localProducers.has(track.id)) continue;
      try {
        const producer = await this.state.sendTransport.produce({ track });
        this.state.localProducers.set(track.id, producer);
        this.log(`Producing local ${track.kind}`);
        producer.on("transportclose", () => {
          this.state.localProducers.delete(track.id);
        });
        producer.on("close", () => {
          this.state.localProducers.delete(track.id);
        });
      } catch (err) {
        this.log(`Failed to produce ${track.kind}: ${err.message}`);
      }
    }
  }

  async #consumeProducer(producerId) {
    if (!this.state.deviceLoaded) {
      if (!this.state.pendingRemoteProducers.includes(producerId)) {
        this.log("Device not ready, queueing producer");
        this.state.pendingRemoteProducers.push(producerId);
      }
      return;
    }
    if (this.state.subscribedProducers.has(producerId)) return;
    this.state.subscribedProducers.add(producerId);
    try {
      const transport = await this.#requestTransport("recv");
      const data = await this.#requestConsume(transport, producerId);
      const consumer = await transport.consume({
        id: data.consumerId,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      });
      await consumer.resume();
      this.#attachRemoteStream(consumer);
      if (
        consumer.kind === "video" &&
        typeof consumer.requestKeyFrame === "function"
      ) {
        try {
          await consumer.requestKeyFrame();
          this.log(`Requested keyframe for producer ${producerId}`);
        } catch (err) {
          this.log(`requestKeyFrame failed: ${err.message}`);
        }
      }
    } catch (err) {
      this.log(`Consume failed: ${err.message}`);
      this.state.subscribedProducers.delete(producerId);
      if (!this.state.pendingRemoteProducers.includes(producerId)) {
        this.state.pendingRemoteProducers.push(producerId);
      }
    }
  }

  async #requestConsume(transport, producerId) {
    const requestId = randomId();
    const promise = new Promise((resolve, reject) => {
      this.state.pendingConsumeRequests.set(requestId, {
        resolve,
        reject,
        producerId,
      });
    });
    this.#send({
      type: "sfu.consume",
      room: this.state.room,
      transportId: transport.id,
      producerId,
      rtpCapabilities: this.state.device.rtpCapabilities,
      requestId,
    });
    return promise;
  }

  async #drainPendingConsumers() {
    if (!this.state.recvTransport || !this.state.deviceLoaded) return;
    const queue = this.state.pendingRemoteProducers.splice(0);
    for (const producerId of queue) {
      await this.#consumeProducer(producerId);
    }
  }

  #attachRemoteStream(consumer) {
    const isAudio = consumer.kind === "audio";
    const element = document.createElement(isAudio ? "audio" : "video");
    element.autoplay = true;
    element.playsInline = true;
    element.dataset.consumerId = consumer.id;
    if (isAudio) {
      element.classList.add("remote-audio");
      element.muted = false;
      element.defaultMuted = false;
    } else {
      element.classList.add("remote-video");
      element.muted = false;
    }

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    const ownerId = this.state.producerOwners.get(consumer.producerId) || null;
    const detail = {
      consumer,
      stream,
      element,
      isAudio,
      ownerId,
    };

    const playback = () => {
      const playPromise = detail.element.play?.();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          this.log(
            `Autoplay blocked for remote ${consumer.kind}; user gesture required.`
          );
          detail.element.controls = true;
        });
      }
    };

    detail.element.srcObject = stream;
    if (consumer.track.muted) {
      const handleUnmute = () => {
        consumer.track.removeEventListener("unmute", handleUnmute);
        playback();
      };
      consumer.track.addEventListener("unmute", handleUnmute);
    } else {
      playback();
    }

    this.state.consumers.set(consumer.id, detail);
    this.state.producerToConsumer.set(consumer.producerId, detail);
    this.dispatchEvent(
      new CustomEvent("remote-track", {
        detail: {
          consumerId: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          stream,
          ownerId,
        },
      })
    );

    const teardown = () => {
      this.#removeConsumer(consumer.id);
    };
    consumer.on("transportclose", teardown);
    consumer.on("producerclose", teardown);
    consumer.on("trackended", teardown);
  }

  #removeConsumer(consumerId) {
    const entry = this.state.consumers.get(consumerId);
    if (!entry) return;
    this.state.consumers.delete(consumerId);
    if (entry.consumer?.producerId) {
      this.state.producerToConsumer.delete(entry.consumer.producerId);
      this.state.producerOwners.delete(entry.consumer.producerId);
    }
    if (entry.consumer && !entry.consumer.closed) {
      try {
        entry.consumer.close();
      } catch (_) {
        /* ignore */
      }
    }
    if (entry.stream) {
      entry.stream.getTracks().forEach((track) => track.stop && track.stop());
    }
    this.dispatchEvent(
      new CustomEvent("remote-track-removed", {
        detail: {
          consumerId,
          producerId: entry.consumer?.producerId,
        },
      })
    );
  }

  #handleTransportConnected(msg) {
    let key = msg.requestId || null;
    let pending = null;
    if (key && this.state.pendingConnectRequests.has(key)) {
      pending = this.state.pendingConnectRequests.get(key);
    } else {
      const iter = this.state.pendingConnectRequests.entries().next();
      if (!iter.done) {
        key = iter.value[0];
        pending = iter.value[1];
      }
    }
    if (!pending || !key) return;
    this.state.pendingConnectRequests.delete(key);
    try {
      pending.callback();
    } catch (err) {
      this.log(`connect callback error: ${err.message}`);
    }
  }

  #handleProduced(msg) {
    let key = msg.requestId || null;
    let pending = null;
    if (key && this.state.pendingProduceRequests.has(key)) {
      pending = this.state.pendingProduceRequests.get(key);
    } else {
      const iter = this.state.pendingProduceRequests.entries().next();
      if (!iter.done) {
        key = iter.value[0];
        pending = iter.value[1];
      }
    }
    if (!pending || !key) return;
    this.state.pendingProduceRequests.delete(key);
    try {
      pending.callback({ id: msg.producerId });
    } catch (err) {
      this.log(`produce callback error: ${err.message}`);
    }
  }

  #handleConsumed(msg) {
    const key = msg.requestId;
    if (!key || !this.state.pendingConsumeRequests.has(key)) return;
    const pending = this.state.pendingConsumeRequests.get(key);
    this.state.pendingConsumeRequests.delete(key);
    pending.resolve(msg);
  }

  #handleNewProducer(msg) {
    if (msg.clientId) {
      this.state.producerOwners.set(msg.producerId, msg.clientId);
    }
    this.#consumeProducer(msg.producerId);
  }

  #handleProducersList(msg) {
    this.log(
      `Received producers list (${(msg.producers || []).length}) for room ${
        msg.room
      }`
    );
    for (const producer of msg.producers || []) {
      if (producer.clientId) {
        this.state.producerOwners.set(producer.producerId, producer.clientId);
      }
      this.#consumeProducer(producer.producerId);
    }
  }

  #handleProducerClosed(msg) {
    const entry = this.state.producerToConsumer.get(msg.producerId);
    if (!entry) return;
    this.#removeConsumer(entry.consumer.id);
  }

  #handleMemberJoined(msg) {
    this.log(`Member joined: ${msg.id} role=${msg.role}`);
  }

  #handleMemberLeft(msg) {
    this.log(`Member left: ${msg.id}`);
    const toRemove = [];
    for (const [producerId, ownerId] of this.state.producerOwners.entries()) {
      if (ownerId === msg.id) {
        toRemove.push(producerId);
      }
    }
    for (const producerId of toRemove) {
      const entry = this.state.producerToConsumer.get(producerId);
      if (entry) this.#removeConsumer(entry.consumer.id);
      this.state.producerOwners.delete(producerId);
    }
    this.dispatchEvent(
      new CustomEvent("member-left", { detail: { clientId: msg.id } })
    );
  }

  #handleMessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      this.log(`Failed to parse message: ${err.message}`);
      return;
    }

    switch (payload.type) {
      case "id":
        this.state.id = payload.id;
        this.log(`Assigned client id ${this.state.id}`);
        break;
      case "joined":
        this.log(`Joined room ${payload.room} as ${payload.role}`);
        this.setStatus(`In room ${payload.room}`);
        this.#send({ type: "sfu.listProducers", room: this.state.room });
        break;
      case "sfu.transportCreated":
        this.#handleTransportCreated(payload).catch((err) => {
          this.log(`Transport setup failed: ${err.message}`);
        });
        break;
      case "sfu.transportConnected":
        this.#handleTransportConnected(payload);
        break;
      case "sfu.produced":
        this.#handleProduced(payload);
        break;
      case "sfu.consumed":
        this.#handleConsumed(payload);
        break;
      case "sfu.newProducer":
        this.#handleNewProducer(payload);
        break;
      case "sfu.producers":
        this.#handleProducersList(payload);
        break;
      case "sfu.producerClosed":
        this.#handleProducerClosed(payload);
        break;
      case "member-joined":
        this.#handleMemberJoined(payload);
        break;
      case "member-left":
        this.#handleMemberLeft(payload);
        break;
      case "error":
        this.log(`Error: ${payload.message}`);
        this.dispatchEvent(
          new CustomEvent("error", { detail: payload.message })
        );
        break;
      default:
        this.log(`Unhandled message ${payload.type || "unknown"}`);
    }
  };

  #handleSocketClose = () => {
    this.log("WebSocket closed");
    this.setStatus("Disconnected");
    this.#resetState();
    this.dispatchEvent(new CustomEvent("disconnected"));
  };

  #handleSocketError = (event) => {
    this.log(`WebSocket error: ${event.message || event.type}`);
    this.dispatchEvent(
      new CustomEvent("error", { detail: event.message || event.type })
    );
  };

  #resetState() {
    if (this.state.ws) {
      this.state.ws.removeEventListener("message", this.#handleMessage);
      this.state.ws.removeEventListener("close", this.#handleSocketClose);
      this.state.ws.removeEventListener("error", this.#handleSocketError);
      try {
        this.state.ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.state.ws = null;

    if (this.state.localStream) {
      this.state.localStream.getTracks().forEach((track) => track.stop());
      this.dispatchEvent(new CustomEvent("local-stream-ended"));
      this.state.localStream = null;
    }

    if (this.state.sendTransport) {
      try {
        this.state.sendTransport.close();
      } catch (_) {}
    }
    if (this.state.recvTransport) {
      try {
        this.state.recvTransport.close();
      } catch (_) {}
    }
    this.state.sendTransport = null;
    this.state.recvTransport = null;
    this.state.device = null;
    this.state.deviceLoaded = false;
    this.state.localProducers.clear();
    for (const consumerId of Array.from(this.state.consumers.keys())) {
      this.#removeConsumer(consumerId);
    }
    this.state.consumers.clear();
    this.state.producerToConsumer.clear();
    this.state.pendingTransportRequests.clear();
    this.state.pendingConnectRequests.clear();
    this.state.pendingProduceRequests.clear();
    this.state.pendingConsumeRequests.clear();
    this.state.subscribedProducers.clear();
    this.state.pendingRemoteProducers = [];
    this.state.producerOwners.clear();
    this.state.room = null;
    this.state.token = null;
    this.state.id = null;
  }
}
