import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const SIGNALING_SERVER =
  import.meta.env.VITE_SIGNALING_SERVER || "https://jap-remote.onrender.com";
const ROOM_ID = "remote-screen-room";

const TURN_USERNAME =
  import.meta.env.VITE_TURN_USERNAME || "f8c9b3659bc5b39d5cde1808";
const TURN_PASSWORD =
  import.meta.env.VITE_TURN_PASSWORD || "PASTE_YOUR_METERED_PASSWORD_HERE";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    },
  ],
};

interface PhoneDevice {
  socketId: string;
  deviceName: string;
  networkType: "wifi" | "cellular" | "unknown";
  isCapturing: boolean;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const selectedPhoneRef = useRef<string | null>(null);
  const approvedCellularRef = useRef<Set<string>>(new Set());

  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [selectedPhoneId, setSelectedPhoneId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Disconnected");
  const [statsText, setStatsText] = useState<string>("No active video stream");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  const selectDevice = (phone: PhoneDevice, forceAllowCellular = false) => {
    const socket = socketRef.current;
    if (!socket) return;

    selectedPhoneRef.current = phone.socketId;
    setSelectedPhoneId(phone.socketId);

    if (forceAllowCellular) {
      approvedCellularRef.current.add(phone.socketId);
    }

    const isCellularAllowed =
      forceAllowCellular || approvedCellularRef.current.has(phone.socketId);

    setStatus(
      `Requesting live stream from ${phone.deviceName} (${phone.networkType.toUpperCase()})...`,
    );
    socket.emit("request-stream", {
      targetSocketId: phone.socketId,
      allowCellular: isCellularAllowed,
    });
  };

  const pauseCurrentStream = () => {
    const socket = socketRef.current;
    if (!socket || !selectedPhoneRef.current) return;

    approvedCellularRef.current.delete(selectedPhoneRef.current);
    socket.emit("stop-stream", {
      targetSocketId: selectedPhoneRef.current,
    });

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
    setStatsText("Stream paused (0 MB data usage)");
    setStatus("Stream paused by viewer.");
  };

  useEffect(() => {
    const socket = io(SIGNALING_SERVER, {
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
    });
    socketRef.current = socket;

    const setupPeerConnection = (targetPhoneSocketId: string) => {
      if (pcRef.current) {
        pcRef.current.close();
      }
      const pc = new RTCPeerConnection(ICE_SERVERS);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", {
            roomId: ROOM_ID,
            targetSocketId: targetPhoneSocketId,
            candidate: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        const videoEl = videoRef.current;
        if (!videoEl) return;

        const inboundStream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);

        videoEl.srcObject = inboundStream;
        videoEl.play().catch((err) => console.warn("Autoplay note:", err));
        setIsStreaming(true);
        setStatus("Live: Streaming Remote Phone Screen!");
      };

      pc.onconnectionstatechange = () => {
        setStatus(`WebRTC State: ${pc.connectionState}`);
        if (
          pc.connectionState === "disconnected" ||
          pc.connectionState === "closed" ||
          pc.connectionState === "failed"
        ) {
          setIsStreaming(false);
        }
      };

      pcRef.current = pc;
      return pc;
    };

    const statsInterval = setInterval(async () => {
      if (!pcRef.current) return;
      const stats = await pcRef.current.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          const mb = ((report.bytesReceived ?? 0) / (1024 * 1024)).toFixed(2);
          setStatsText(
            `Data Received: ${mb} MB | Frames Decoded: ${
              report.framesDecoded ?? 0
            }`,
          );
        }
      });
    }, 1000);

    socket.on("connect", () => {
      setStatus(`Connected to Render (${socket.id}) — Waiting for phones...`);
      socket.emit("join-room", { roomId: ROOM_ID, role: "viewer" });
    });

    socket.on("devices-list", (phoneList: PhoneDevice[]) => {
      setDevices(phoneList);

      if (phoneList.length === 0) {
        selectedPhoneRef.current = null;
        setSelectedPhoneId(null);
        setIsStreaming(false);
        setStatus("No phones connected — Open the app on your phone.");
        return;
      }

      const currentId = selectedPhoneRef.current;
      const activePhone =
        phoneList.find((p) => p.socketId === currentId) || phoneList[0];

      if (!currentId || currentId !== activePhone.socketId) {
        selectDevice(activePhone, false);
      }
    });

    socket.on(
      "offer",
      async (payload: {
        fromSocketId?: string;
        offer: RTCSessionDescriptionInit;
      }) => {
        const offer =
          payload.offer || (payload as unknown as RTCSessionDescriptionInit);
        const fromId = payload.fromSocketId || selectedPhoneRef.current || "";

        if (
          selectedPhoneRef.current &&
          fromId &&
          fromId !== selectedPhoneRef.current
        ) {
          return;
        }

        setStatus("Offer received from Phone! Connecting stream...");
        candidateQueueRef.current = [];
        const pc = setupPeerConnection(fromId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        while (candidateQueueRef.current.length > 0) {
          const c = candidateQueueRef.current.shift()!;
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(console.error);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", {
          roomId: ROOM_ID,
          targetSocketId: fromId,
          answer,
        });
      },
    );

    socket.on(
      "ice-candidate",
      async (payload: {
        fromSocketId?: string;
        candidate: RTCIceCandidateInit;
      }) => {
        const candidate =
          payload.candidate || (payload as unknown as RTCIceCandidateInit);
        const pc = pcRef.current;
        if (!pc || !candidate) return;
        if (!pc.remoteDescription) {
          candidateQueueRef.current.push(candidate);
        } else {
          await pc
            .addIceCandidate(new RTCIceCandidate(candidate))
            .catch(console.error);
        }
      },
    );

    return () => {
      clearInterval(statsInterval);
      socket.disconnect();
      pcRef.current?.close();
    };
  }, []);

  const selectedPhone =
    devices.find((d) => d.socketId === selectedPhoneId) || null;

  return (
    <div
      style={{
        padding: 24,
        fontFamily: "sans-serif",
        background: "#121212",
        color: "#fff",
        minHeight: "100vh",
      }}
    >
      <h2 style={{ marginTop: 0 }}>Remote Screen Console</h2>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "#9ca3af", marginBottom: 8 }}>
          Connected Phones ({devices.length}):
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {devices.map((phone) => {
            const isSelected = phone.socketId === selectedPhoneId;
            const isWifi = phone.networkType === "wifi";
            return (
              <button
                key={phone.socketId}
                onClick={() => selectDevice(phone, false)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: isSelected
                    ? "2px solid #3b82f6"
                    : "1px solid #374151",
                  background: isSelected ? "#1e3a8a" : "#1f2937",
                  color: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontWeight: 600,
                }}
              >
                <span>{phone.deviceName}</span>
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: isWifi ? "#065f46" : "#78350f",
                    color: isWifi ? "#6ee7b7" : "#fde68a",
                  }}
                >
                  {isWifi
                    ? "📶 Wi-Fi (Auto)"
                    : phone.networkType === "cellular"
                      ? "📱 Mobile Data"
                      : "🌐 Unknown"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p style={{ color: "#4ade80", fontWeight: 600, marginBottom: 4 }}>
        Status: {status}
      </p>
      <p style={{ color: "#fbbf24", fontSize: 14, marginTop: 0 }}>
        {statsText}
      </p>

      {selectedPhone && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 8,
            background:
              selectedPhone.networkType === "cellular" ? "#451a03" : "#1f2937",
            border:
              selectedPhone.networkType === "cellular"
                ? "1px solid #d97706"
                : "1px solid #374151",
            maxWidth: 420,
          }}
        >
          {selectedPhone.networkType === "cellular" ? (
            <div>
              <div
                style={{
                  color: "#fde68a",
                  fontSize: 13,
                  marginBottom: 10,
                }}
              >
                ⚠️ <strong>{selectedPhone.deviceName}</strong> is using{" "}
                <strong>Mobile Data</strong>. Auto-stream is paused to save your
                TURN data quota.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => selectDevice(selectedPhone, true)}
                  style={{
                    flex: 1,
                    padding: "10px 14px",
                    background: "#d97706",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {isStreaming
                    ? "🔄 Reconnect Mobile Data Stream"
                    : "▶️ Connect Stream (Mobile Data)"}
                </button>
                {isStreaming && (
                  <button
                    onClick={pauseCurrentStream}
                    style={{
                      padding: "10px 14px",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ⏸ Pause
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: 13, color: "#6ee7b7" }}>
                📶 Connected via Wi-Fi (Auto-Streaming)
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => selectDevice(selectedPhone, false)}
                  style={{
                    padding: "6px 12px",
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  🔄 Refresh Stream
                </button>
                {isStreaming && (
                  <button
                    onClick={pauseCurrentStream}
                    style={{
                      padding: "6px 12px",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ⏸ Pause
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 8,
          overflow: "hidden",
          maxWidth: 420,
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls
          style={{
            width: "100%",
            display: "block",
            background: "#000",
            minHeight: 640,
          }}
        />
      </div>
    </div>
  );
}
