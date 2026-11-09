import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

const SIGNALING_SERVER = import.meta.env.VITE_SIGNALING_SERVER;
const ROOM_ID = "remote-screen-room";

const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME;
const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD;

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

export default function RemoteScreen() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const [status, setStatus] = useState<string>("Disconnected");
  const [statsText, setStatsText] = useState<string>("No video track yet");

  useEffect(() => {
    const socket = io(SIGNALING_SERVER, {
      transports: ["polling", "websocket"],
      reconnection: true,
    });
    socketRef.current = socket;

    const setupPeerConnection = () => {
      if (pcRef.current) {
        pcRef.current.close();
      }
      const pc = new RTCPeerConnection(ICE_SERVERS);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", {
            roomId: ROOM_ID,
            candidate: event.candidate,
          });
        }
      };

      pc.ontrack = (event) => {
        console.log("[Desktop] ontrack fired!", event);
        const videoEl = videoRef.current;
        if (!videoEl) return;

        // Build stream directly from event.track in case event.streams[0] is empty
        const inboundStream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : new MediaStream([event.track]);

        videoEl.srcObject = inboundStream;
        videoEl.play().catch((err) => console.warn("Autoplay warning:", err));
        setStatus("Track attached! Waiting for frames...");
      };

      pc.onconnectionstatechange = () => {
        setStatus(`WebRTC State: ${pc.connectionState}`);
      };

      pcRef.current = pc;
      return pc;
    };

    // Poll WebRTC stats every second so you can see if bytes/frames are arriving
    const statsInterval = setInterval(async () => {
      if (!pcRef.current) return;
      const stats = await pcRef.current.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          setStatsText(
            `Bytes Received: ${report.bytesReceived ?? 0} | Frames Decoded: ${report.framesDecoded ?? 0}`,
          );
        }
      });
    }, 1000);

    socket.on("connect", () => {
      setStatus(`Connected to Render (${socket.id}) — Waiting for phone...`);
      setupPeerConnection();
      socket.emit("join-room", ROOM_ID);
    });

    socket.on("offer", async (offer: RTCSessionDescriptionInit) => {
      setStatus("Offer received! Sending answer...");
      const pc = setupPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Drain any ICE candidates that arrived early
      while (candidateQueueRef.current.length > 0) {
        const c = candidateQueueRef.current.shift()!;
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { roomId: ROOM_ID, answer });
    });

    socket.on("ice-candidate", async (candidate: RTCIceCandidateInit) => {
      const pc = pcRef.current;
      if (!pc || !candidate) return;
      if (!pc.remoteDescription) {
        candidateQueueRef.current.push(candidate);
      } else {
        await pc
          .addIceCandidate(new RTCIceCandidate(candidate))
          .catch(console.error);
      }
    });

    return () => {
      clearInterval(statsInterval);
      socket.disconnect();
      pcRef.current?.close();
    };
  }, []);

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
      <h2>Remote Screen Console</h2>
      <p style={{ color: "#4ade80", fontWeight: 600, marginBottom: 4 }}>
        Status: {status}
      </p>
      <p style={{ color: "#fbbf24", fontSize: 14, marginTop: 0 }}>
        {statsText}
      </p>
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
