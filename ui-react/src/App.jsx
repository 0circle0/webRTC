import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SFUClient } from "./lib/sfuClient.js";

function useMediaAttach(
  stream,
  { kind = "video", muted = false, unmuteAfterAutoplay = false } = {}
) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const attemptPlayback = () => {
      try {
        const playPromise = el.play?.();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise
            .then(() => {
              if (kind === "audio" && unmuteAfterAutoplay) {
                el.muted = false;
                el.defaultMuted = false;
              }
            })
            .catch((err) => {
              console.warn(
                `Media playback blocked (${kind}): ${err?.message || err}`
              );
            });
        } else if (kind === "audio" && unmuteAfterAutoplay) {
          el.muted = false;
          el.defaultMuted = false;
        }
      } catch (err) {
        console.warn(`Media playback error (${kind}): ${err?.message || err}`);
      }
    };

    const handleLoaded = () => {
      if (el.readyState < 2) {
        attemptPlayback();
      }
    };

    const handlePlaying = () => {
      if (kind === "audio" && unmuteAfterAutoplay) {
        el.muted = false;
        el.defaultMuted = false;
      }
    };

    if (!stream) {
      el.pause?.();
      el.srcObject = null;
      return;
    }

    el.srcObject = stream;
    if (kind === "video") {
      el.playsInline = true;
      el.autoplay = true;
    }

    let targetMuted = muted;
    if (kind === "audio" && unmuteAfterAutoplay) {
      targetMuted = true;
    }
    el.muted = targetMuted;
    el.defaultMuted = targetMuted;
    el.controls = false;

    el.addEventListener("loadedmetadata", handleLoaded);
    el.addEventListener("canplay", handleLoaded);
    if (kind === "audio" && unmuteAfterAutoplay) {
      el.addEventListener("playing", handlePlaying, { once: true });
    }

    attemptPlayback();

    return () => {
      el.removeEventListener("loadedmetadata", handleLoaded);
      el.removeEventListener("canplay", handleLoaded);
      if (kind === "audio" && unmuteAfterAutoplay) {
        el.removeEventListener("playing", handlePlaying);
      }
    };
  }, [stream, kind, muted, unmuteAfterAutoplay]);
  return ref;
}

function VideoTile({ stream, label, muted = false }) {
  const ref = useMediaAttach(stream, { kind: "video", muted });
  return (
    <div className="video-tile">
      <video ref={ref} playsInline autoPlay muted={muted} />
      <div className="video-label">{label}</div>
    </div>
  );
}

function AudioSink({ stream }) {
  const ref = useMediaAttach(stream, {
    kind: "audio",
    muted: false,
    unmuteAfterAutoplay: true,
  });
  return <audio ref={ref} autoPlay />;
}

export default function App() {
  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new SFUClient();
  }
  const client = clientRef.current;

  const defaultWs = useMemo(() => {
    const { hostname } = window.location;
    return `ws://${hostname || "localhost"}:3000`;
  }, []);

  const [wsUrl, setWsUrl] = useState(defaultWs);
  const [room, setRoom] = useState("test");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("Disconnected");
  const [logs, setLogs] = useState([]);
  const [joining, setJoining] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteMedia, setRemoteMedia] = useState([]);
  const [videoDevices, setVideoDevices] = useState([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState("");

  const appendLog = useCallback((message) => {
    setLogs((prev) => {
      const next = [...prev, message];
      if (next.length > 300) next.shift();
      return next;
    });
  }, []);

  useEffect(() => {
    const handleLog = (event) => {
      const time = new Date().toLocaleTimeString();
      appendLog(`[${time}] ${event.detail}`);
    };
    const handleStatus = (event) => setStatus(event.detail);
    const handleLocal = (event) => setLocalStream(event.detail.stream);
    const handleLocalEnded = () => setLocalStream(null);
    const handleRemoteTrack = (event) => {
      const { consumerId, kind, stream, ownerId } = event.detail;
      const shortId = consumerId ? consumerId.slice(0, 6) : "unknown";
      appendLog(
        `[remote-track] ${kind} consumer=${shortId} owner=${
          ownerId || "unknown"
        }`
      );
      setRemoteMedia((prev) => {
        const others = prev.filter((item) => item.consumerId !== consumerId);
        return [...others, { consumerId, kind, stream, ownerId }];
      });
    };
    const handleRemoteRemoved = (event) => {
      const { consumerId } = event.detail;
      setRemoteMedia((prev) =>
        prev.filter((item) => item.consumerId !== consumerId)
      );
    };
    const handleMemberLeftEvent = (event) => {
      const { clientId } = event.detail || {};
      if (!clientId) return;
      setRemoteMedia((prev) =>
        prev.filter((item) => item.ownerId && item.ownerId !== clientId)
      );
    };
    const handleDevices = (event) => {
      const { videoInputs = [], currentVideoDeviceId } = event.detail || {};
      setVideoDevices(videoInputs);
      setSelectedVideoDevice((prev) => {
        if (
          currentVideoDeviceId &&
          videoInputs.some((device) => device.deviceId === currentVideoDeviceId)
        ) {
          return currentVideoDeviceId;
        }
        if (prev && videoInputs.some((device) => device.deviceId === prev)) {
          return prev;
        }
        return videoInputs[0]?.deviceId || "";
      });
    };
    const handleError = (event) => appendLog(`[error] ${event.detail}`);
    const handleDisconnected = () => {
      setStatus("Disconnected");
      setRemoteMedia([]);
      setVideoDevices([]);
      setSelectedVideoDevice("");
    };

    client.addEventListener("log", handleLog);
    client.addEventListener("status", handleStatus);
    client.addEventListener("local-stream", handleLocal);
    client.addEventListener("local-stream-ended", handleLocalEnded);
    client.addEventListener("remote-track", handleRemoteTrack);
    client.addEventListener("remote-track-removed", handleRemoteRemoved);
    client.addEventListener("member-left", handleMemberLeftEvent);
    client.addEventListener("devices", handleDevices);
    client.addEventListener("error", handleError);
    client.addEventListener("disconnected", handleDisconnected);

    return () => {
      client.removeEventListener("log", handleLog);
      client.removeEventListener("status", handleStatus);
      client.removeEventListener("local-stream", handleLocal);
      client.removeEventListener("local-stream-ended", handleLocalEnded);
      client.removeEventListener("remote-track", handleRemoteTrack);
      client.removeEventListener("remote-track-removed", handleRemoteRemoved);
      client.removeEventListener("member-left", handleMemberLeftEvent);
      client.removeEventListener("devices", handleDevices);
      client.removeEventListener("error", handleError);
      client.removeEventListener("disconnected", handleDisconnected);
    };
  }, [client, appendLog]);

  useEffect(() => {
    return () => {
      client.leave().catch(() => {});
    };
  }, [client]);

  const handleCameraChange = async (event) => {
    const deviceId = event.target.value;
    if (!deviceId) return;
    const previous = selectedVideoDevice;
    setSelectedVideoDevice(deviceId);
    try {
      await client.setVideoInput(deviceId);
    } catch (err) {
      setSelectedVideoDevice(previous);
      appendLog(`[camera] ${err.message}`);
    }
  };

  const handleRefreshCameras = async () => {
    try {
      await client.refreshDevices();
    } catch (err) {
      appendLog(`[camera] refresh failed: ${err.message}`);
    }
  };

  const handleJoin = async (event) => {
    event.preventDefault();
    if (joining) return;
    try {
      setJoining(true);
      await client.join({
        wsUrl,
        room: room.trim(),
        token: token.trim() || null,
      });
      await client.refreshDevices();
    } catch (err) {
      appendLog(`[join failed] ${err.message}`);
      setStatus("Disconnected");
    } finally {
      setJoining(false);
    }
  };

  const handleLeave = async () => {
    await client.leave();
    setStatus("Disconnected");
    setRemoteMedia([]);
    setLocalStream(null);
    setVideoDevices([]);
    setSelectedVideoDevice("");
  };

  return (
    <div className="app">
      <header className="panel">
        <h1>WebRTC SFU React</h1>
        <p className="status">Status: {status}</p>
      </header>

      <section className="panel">
        <form className="controls" onSubmit={handleJoin}>
          <label>
            WebSocket URL
            <input
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              placeholder={defaultWs}
              autoComplete="off"
            />
          </label>
          <label>
            Room
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="demo-room"
              required
            />
          </label>
          <label>
            Token (optional)
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="button-row">
            <button type="submit" disabled={joining}>
              Join & Share Video
            </button>
            <button type="button" onClick={handleLeave}>
              Leave
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Local Video</h2>
        {localStream ? (
          <VideoTile stream={localStream} label="Local" muted />
        ) : (
          <div className="placeholder">Not sharing</div>
        )}
        <div className="device-row">
          <label>
            Camera
            <select
              value={selectedVideoDevice}
              onChange={handleCameraChange}
              disabled={!videoDevices.length}
            >
              {videoDevices.length === 0 ? (
                <option value="">No cameras detected</option>
              ) : (
                videoDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={handleRefreshCameras}
            disabled={joining}
          >
            Refresh
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Remote Participants</h2>
        <div className="videos-grid">
          {remoteMedia.filter((item) => item.kind === "video").length === 0 && (
            <div className="placeholder">No remote video yet</div>
          )}
          {remoteMedia
            .filter((item) => item.kind === "video")
            .map((item) => (
              <VideoTile
                key={item.consumerId}
                stream={item.stream}
                label={`Remote ${item.consumerId.slice(0, 6)}`}
                muted={false}
              />
            ))}
        </div>
        {remoteMedia
          .filter((item) => item.kind === "audio")
          .map((item) => (
            <AudioSink key={item.consumerId} stream={item.stream} />
          ))}
      </section>

      <section className="panel">
        <h2>Event Log</h2>
        <pre className="log" aria-live="polite">
          {logs.join("\n")}
        </pre>
      </section>
    </div>
  );
}
