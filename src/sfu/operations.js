const { getListenIps, getIceServers } = require("../config");
const fetch = require("node-fetch");

// Environment/config normalization
const RECORDER_API =
  process.env.RECORDER_API_URL ||
  process.env.RECORDER_URL ||
  "http://localhost:4000";
const rawHost = process.env.RECORDER_HOST || "127.0.0.1";
const destIp = rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost;
const destPort = Number(process.env.RECORDER_RTP_PORT || 5004);

function createSfuOperations(context) {
  const { emitter, options } = context;

  async function createWebRtcTransport({
    roomName,
    clientId,
    direction = "send",
  }) {
    if (!roomName) throw new Error("roomName required");
    const roomCtx = await context.ensureRoomContext(roomName);
    const listenIps = options.listenIps || getListenIps();
    console.log("Creating WebRTC transport", {
      room: roomName,
      clientId,
      direction,
      listenIps,
    });

    const transport = await roomCtx.router.createWebRtcTransport({
      listenIps,
      enableUdp: options.enableUdp,
      enableTcp: options.enableTcp,
      preferUdp: options.preferUdp,
      appData: { roomName, clientId, direction },
    });

    context.registerTransport(transport, { roomName, clientId, direction });

    const cleanup = (reason) => {
      const meta = context.unregisterTransport(transport.id) || {
        roomName,
        clientId,
        direction,
      };
      emitter.emit("transport-closed", {
        roomName: meta.roomName,
        clientId: meta.clientId,
        transportId: transport.id,
        direction: meta.direction,
        reason,
      });
    };

    transport.on("close", () => cleanup("close"));
    transport.on("routerclose", () => cleanup("routerclose"));

    return {
      transport,
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers: getIceServers(),
      routerRtpCapabilities: roomCtx.router.rtpCapabilities,
      roomName,
      direction,
    };
  }

  async function connectTransport({ transportId, dtlsParameters }) {
    const meta = context.getTransport(transportId);
    if (!meta) throw new Error("transport not found");
    await meta.transport.connect({ dtlsParameters });
    return { transportId };
  }

  async function closeTransport(transportId) {
    const meta = context.getTransport(transportId);
    if (!meta) return false;
    meta.transport.close();
    return true;
  }

  async function createProducer({
    transportId,
    roomName,
    clientId,
    kind,
    rtpParameters,
  }) {
    const transportMeta = context.getTransport(transportId);
    if (!transportMeta) throw new Error("transport not found");
    if (roomName && transportMeta.roomName !== roomName)
      throw new Error("transport belongs to different room");

    const producer = await transportMeta.transport.produce({
      kind,
      rtpParameters,
      appData: { roomName: transportMeta.roomName, clientId },
    });

    const roomCtx = await context.ensureRoomContext(transportMeta.roomName);
    context.registerProducer(producer, {
      roomName: transportMeta.roomName,
      clientId,
      kind,
    });

    // Automatically start recording for video producers
    let recordingTransport, recordingConsumer;
    if (kind === "video") {
      console.log(
        `[SFU] Starting recording for producer ${producer.id} in room ${transportMeta.roomName}`
      );
      // Create PlainTransport for recording
      recordingTransport = await roomCtx.router.createPlainTransport({
        comedia: false,
        rtcpMux: true,
        listenIp: { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
      });
      await recordingTransport.connect({ ip: destIp, port: destPort });
      console.log("[SFU][recording] connect ->", { destIp, destPort });
      context.registerTransport(recordingTransport, {
        roomName: transportMeta.roomName,
        clientId,
        direction: "record",
        recording: true,
      });
      // Create Consumer for recording
      recordingConsumer = await recordingTransport.consume({
        producerId: producer.id,
        rtpCapabilities: roomCtx.router.rtpCapabilities,
        paused: true, // start paused, resume after /start
        appData: {
          roomName: transportMeta.roomName,
          clientId,
          recording: true,
        },
      });
      console.log("[SFU][recording] Created Consumer:", {
        id: recordingConsumer.id,
        producerId: producer.id,
        kind,
      });
      console.log(
        "[SFU][recording] Consumer RTP params:",
        recordingConsumer.rtpParameters
      );
      // Extract only VP8 codec info (ignore RTX)
      const rtp = recordingConsumer.rtpParameters;
      const vp8 = rtp.codecs.find(
        (c) => String(c.mimeType).toLowerCase() === "video/vp8"
      );
      if (!vp8) {
        console.error(
          "[SFU][recording] No VP8 codec found in consumer params",
          rtp.codecs
        );
        return;
      }
      const payloadType = vp8.payloadType;
      const ssrc = rtp.encodings?.[0]?.ssrc;
      console.log("[SFU][recording] rtp summary", { payloadType, ssrc });
      // Call recorder /start and log request/response/errors
      const body = {
        ip: destIp,
        port: destPort,
        codec: "video",
        producerId: producer.id,
        payloadType,
        ssrc,
      };
      console.log("[SFU][recording] POST /start", {
        url: `${RECORDER_API}/start`,
        body,
      });
      let startResp;
      try {
        startResp = await fetch(`${RECORDER_API}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const startJson = await startResp.json().catch(() => ({}));
        console.log("[SFU][recording] /start response", {
          status: startResp.status,
          json: startJson,
        });
        if (!startResp.ok || startJson.ok === false) {
          console.error("[SFU][recording] /start failed", startJson);
          return;
        }
      } catch (err) {
        console.error("[SFU][recording] /start error", err);
        return;
      }
      // Resume + request keyframe after /start succeeds
      try {
        await recordingConsumer.resume();
        console.log("[SFU][recording] consumer resumed");
        try {
          await recordingConsumer.requestKeyFrame();
        } catch {}
        console.log("[SFU][recording] keyframe requested");
      } catch (e) {
        console.error("[SFU][recording] resume/requestKeyFrame failed", e);
      }
      // Only stop when producer truly ends
      const stopRecording = async () => {
        console.log("[SFU][recording] stopping for", producer.id);
        try {
          await fetch(`${RECORDER_API}/stop`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ producerId: producer.id }),
          }).catch(() => {});
        } finally {
          try {
            await recordingConsumer.close();
          } catch {}
          try {
            await recordingTransport.close();
          } catch {}
        }
      };
      recordingConsumer.on("transportclose", stopRecording);
      recordingConsumer.on("producerclose", stopRecording);
    }

    producer.on("transportclose", () => cleanup("transportclose"));
    producer.on("close", () => cleanup("close"));

    return { producer, producerId: producer.id };
  }

  async function createConsumer({
    transportId,
    producerId,
    rtpCapabilities,
    clientId,
  }) {
    const transportMeta = context.getTransport(transportId);
    if (!transportMeta) throw new Error("transport not found");
    const producerMeta = context.getProducer(producerId);
    if (!producerMeta) throw new Error("producer not found");

    const roomCtx = await context.ensureRoomContext(producerMeta.roomName);
    if (
      !roomCtx.router.canConsume({
        producerId: producerMeta.producer.id,
        rtpCapabilities,
      })
    ) {
      throw new Error("cannot consume with provided rtpCapabilities");
    }

    const consumer = await transportMeta.transport.consume({
      producerId: producerMeta.producer.id,
      rtpCapabilities,
      paused: false,
      appData: { roomName: producerMeta.roomName, clientId },
    });

    try {
      await consumer.resume();
    } catch (err) {
      console.warn(
        "Failed to resume consumer immediately",
        consumer.id,
        err.message
      );
    }

    context.registerConsumer(consumer, {
      roomName: producerMeta.roomName,
      clientId,
    });

    const cleanup = (reason) => {
      const meta = context.unregisterConsumer(consumer.id) || {
        roomName: producerMeta.roomName,
        clientId,
      };
      emitter.emit("consumer-closed", {
        roomName: meta.roomName,
        clientId: meta.clientId,
        consumerId: consumer.id,
        reason,
      });
    };

    consumer.on("transportclose", () => cleanup("transportclose"));
    consumer.on("producerclose", () => cleanup("producerclose"));
    consumer.on("close", () => cleanup("close"));

    return { consumer, consumerId: consumer.id };
  }

  function closeClient(clientId) {
    context.closeClientResources(clientId);
  }

  async function closeProducer(producerId) {
    const meta = context.getProducer(producerId);
    if (!meta) return false;
    meta.producer.close();
    return true;
  }

  async function closeConsumer(consumerId) {
    const meta = context.getConsumer(consumerId);
    if (!meta) return false;
    meta.consumer.close();
    return true;
  }

  function getRoomsOverview() {
    return context.getRoomsOverview();
  }

  function getMetrics() {
    return context.getMetrics();
  }

  // Recording: Start recording a producer's stream via PlainRtpTransport
  async function startRecording({ roomName, producerId, recordingServer }) {
    const roomCtx = await context.ensureRoomContext(roomName);
    const producerMeta = context.getProducer(producerId);
    if (!producerMeta) throw new Error("producer not found");

    console.log(
      `[SFU] startRecording called for producer ${producerId} in room ${roomName}`
    );
    // Create PlainTransport for recording
    const transport = await roomCtx.router.createPlainTransport({
      listenIp: recordingServer.listenIp || "127.0.0.1",
      rtcpMux: true,
      comedia: false,
    });
    console.log(`[SFU] Created PlainTransport for recording:`, {
      id: transport.id,
      ip: transport.tuple.localIp,
      port: transport.tuple.localPort,
    });
    // Register transport for cleanup
    context.registerTransport(transport, {
      roomName,
      clientId: producerMeta.clientId,
      direction: "record",
      recording: true,
    });
    // Create a Consumer for the producer on the recording transport
    let consumer;
    try {
      consumer = await transport.consume({
        producerId: producerMeta.producer.id,
        rtpCapabilities: roomCtx.router.rtpCapabilities,
        paused: false,
        appData: { roomName, clientId: producerMeta.clientId, recording: true },
      });
      console.log(`[SFU] Created recording Consumer:`, {
        id: consumer.id,
        producerId: producerMeta.producer.id,
        kind: producerMeta.producer.kind,
      });
      // Log RTP parameters for debugging
      console.log(
        `[SFU] Recording Consumer RTP parameters:`,
        consumer.rtpParameters
      );
      // Resume the consumer to start sending RTP
      await consumer.resume();
    } catch (err) {
      console.error(`[SFU] Failed to create recording Consumer:`, err);
    }
    // Notify microservice (e.g., via HTTP or other IPC)
    // TODO: Implement actual communication to microservice
    // Example: send transport.ip/port, codec info, producerId
    let payloadType, ssrc;
    if (
      consumer &&
      consumer.rtpParameters &&
      consumer.rtpParameters.codecs &&
      consumer.rtpParameters.codecs.length > 0
    ) {
      for (const codec of consumer.rtpParameters.codecs) {
        if (codec.mimeType && codec.mimeType.toUpperCase().includes("VP8")) {
          payloadType = codec.payloadType;
          break;
        }
      }
      if (typeof payloadType === "undefined") {
        console.warn(
          "[SFU] Could not find VP8 payloadType in startRecording, using first codec as fallback."
        );
        payloadType = consumer.rtpParameters.codecs[0].payloadType;
      }
      if (
        consumer.rtpParameters.encodings &&
        consumer.rtpParameters.encodings.length > 0
      ) {
        ssrc = consumer.rtpParameters.encodings[0].ssrc;
      }
    }
    return {
      transportId: transport.id,
      ip: transport.tuple.localIp,
      port: transport.tuple.localPort,
      codec: producerMeta.producer.kind,
      producerId,
      payloadType,
      ssrc,
    };
  }

  // Recording: Stop recording and cleanup
  async function stopRecording({ transportId }) {
    const meta = context.getTransport(transportId);
    if (!meta || !meta.recording) return false;
    meta.transport.close();
    // TODO: Notify microservice to finalize file
    return true;
  }

  return {
    createWebRtcTransport,
    connectTransport,
    closeTransport,
    createProducer,
    createConsumer,
    closeClient,
    closeProducer,
    closeConsumer,
    getRoomsOverview,
    getMetrics,
    startRecording,
    stopRecording,
  };
}

module.exports = { createSfuOperations };
