import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Room, RoomEvent, Track } from "livekit-client";

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";

import "./App.css";

type Device = {
  deviceId: string;
  label: string;
};

type NearbyPlayer = {
  name: string;
  steamId: string;
  volume: number;
};

type VoiceMode = "open" | "ptt";

type TooltipProps = {
  title: string;
  body: string;
};

type SnapshotMessage = {
  type: "snapshot";
  self: {
    x: number;
    y: number;
    z: number;
  } | null;
  nearby: NearbyPlayer[];
};

const API_URL = "https://greenland-voice.onrender.com";
const WS_URL = "wss://greenland-voice.onrender.com/ws";

const SUPPORT_URL =
  "https://discord.com/channels/YOUR_SERVER_ID/YOUR_CHANNEL_ID";

function Tooltip({ title, body }: TooltipProps) {
  return (
    <div className="tooltip">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function App() {
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);

  const [selectedInput, setSelectedInput] = useState(
    localStorage.getItem("audioInput") || "",
  );

  const [selectedOutput, setSelectedOutput] = useState(
    localStorage.getItem("audioOutput") || "",
  );

  const [voiceMode, setVoiceMode] = useState<VoiceMode>(
    (localStorage.getItem("voiceMode") as VoiceMode) || "open",
  );

  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);

  const [gamePid, setGamePid] = useState<number | null>(null);

  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const [playerPosition, setPlayerPosition] = useState<{
    x: number;
    y: number;
    z: number;
  } | null>(null);

  const [nearbyPlayers, setNearbyPlayers] = useState<NearbyPlayer[]>([]);

  const [steamId, setSteamId] = useState<string | null>(null);

  const [steamVerified, setSteamVerified] = useState(false);
  const [steamVerifying, setSteamVerifying] = useState(false);

  const [sessionToken, setSessionToken] = useState<string | null>(
    localStorage.getItem("greenlandSession"),
  );

  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);

  const roomRef = useRef<Room | null>(null);

  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const nearbyPlayersRef = useRef<NearbyPlayer[]>([]);

  const selectedOutputRef = useRef(selectedOutput);

  const mutedRef = useRef(muted);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const micTestActiveRef = useRef(micTestActive);

  const micTestContextRef = useRef<AudioContext | null>(null);
  const micTestSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micTestDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null,
  );

  const micTestAudioRef = useRef<HTMLAudioElement | null>(null);

  const applyRemoteVolumes = () => {
    const nearby = nearbyPlayersRef.current;

    for (const [remoteSteamId, audio] of remoteAudioRef.current.entries()) {
      const player = nearby.find((player) => player.steamId === remoteSteamId);

      audio.volume = player ? Math.max(0, Math.min(1, player.volume)) : 0;
    }
  };

  const cleanupRemoteAudio = () => {
    for (const audio of remoteAudioRef.current.values()) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }

    remoteAudioRef.current.clear();
  };

  const clearSession = () => {
    localStorage.removeItem("greenlandSession");

    setSessionToken(null);
    setSteamVerified(false);
  };

  const setLiveKitMic = async (enabled: boolean) => {
    const room = roomRef.current;

    if (!room) {
      setIsTransmitting(false);
      return;
    }

    try {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setIsTransmitting(enabled);
    } catch (error) {
      console.error("Unable to change microphone state:", error);
      setIsTransmitting(false);
    }
  };

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  useEffect(() => {
    micTestActiveRef.current = micTestActive;
  }, [micTestActive]);

  useEffect(() => {
    selectedOutputRef.current = selectedOutput;
  }, [selectedOutput]);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        const devices = await navigator.mediaDevices.enumerateDevices();

        const inputDevices = devices
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || "Microphone",
          }));

        const outputDevices = devices
          .filter((device) => device.kind === "audiooutput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label || "Output Device",
          }));

        setInputs(inputDevices);
        setOutputs(outputDevices);

        if (!selectedInput && inputDevices.length > 0) {
          setSelectedInput(inputDevices[0].deviceId);
        }

        if (!selectedOutput && outputDevices.length > 0) {
          setSelectedOutput(outputDevices[0].deviceId);
        }

        stream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        console.error("Unable to load audio devices:", error);
      }
    };

    loadDevices();
  }, []);

  useEffect(() => {
    if (!selectedInput) return;

    let audioContext: AudioContext | null = null;

    const startMic = async () => {
      try {
        streamRef.current?.getTracks().forEach((track) => track.stop());

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: {
              exact: selectedInput,
            },
          },
        });

        streamRef.current = stream;

        audioContext = new AudioContext();

        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();

        analyser.fftSize = 256;

        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const updateLevel = () => {
          analyser.getByteFrequencyData(data);

          const average =
            data.reduce((sum, value) => sum + value, 0) / data.length;

          setMicLevel(Math.min(100, average * 1.5));

          animationRef.current = requestAnimationFrame(updateLevel);
        };

        updateLevel();
      } catch (error) {
        console.error("Unable to start microphone:", error);
      }
    };

    startMic();

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());

      audioContext?.close();
    };
  }, [selectedInput]);

  useEffect(() => {
    const checkGame = async () => {
      try {
        const pid = await invoke<number | null>("get_the_isle_pid");

        setGamePid(pid);
      } catch (error) {
        console.error("Unable to detect The Isle:", error);

        setGamePid(null);
      }
    };

    checkGame();

    invoke<string | null>("get_steam_id")
      .then((detectedSteamId) => {
        setSteamId(detectedSteamId);
      })
      .catch((error) => {
        console.error("SteamID detection failed:", error);
      });

    const interval = setInterval(checkGame, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!sessionToken || !steamId) {
      setSteamVerified(false);

      return;
    }

    const validateSession = async () => {
      try {
        const response = await fetch(`${API_URL}/auth/me`, {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });

        if (!response.ok) {
          clearSession();

          return;
        }

        const data = (await response.json()) as {
          authenticated: boolean;
          steamId?: string;
        };

        if (!data.authenticated || !data.steamId || data.steamId !== steamId) {
          clearSession();

          return;
        }

        setSteamVerified(true);
      } catch (error) {
        console.error("Unable to validate Steam session:", error);
      }
    };

    validateSession();
  }, [sessionToken, steamId]);

  const verifySteam = async () => {
    if (!steamId || steamVerifying) return;

    try {
      setSteamVerifying(true);

      const response = await fetch(
        `${API_URL}/auth/steam/start?steamId=${encodeURIComponent(steamId)}`,
      );

      if (!response.ok) {
        throw new Error("Unable to start Steam verification");
      }

      const data = (await response.json()) as {
        authId: string;
        url: string;
      };

      await openUrl(data.url);

      const startedAt = Date.now();
      const timeout = 5 * 60 * 1000;

      while (Date.now() - startedAt < timeout) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));

        const statusResponse = await fetch(
          `${API_URL}/auth/steam/status?authId=${encodeURIComponent(
            data.authId,
          )}`,
        );

        if (statusResponse.status === 404) {
          throw new Error("Steam verification expired");
        }

        if (!statusResponse.ok) {
          continue;
        }

        const status = (await statusResponse.json()) as {
          status: string;
          token?: string;
          steamId?: string;
        };

        if (status.status !== "verified") {
          continue;
        }

        if (!status.token || status.steamId !== steamId) {
          throw new Error("Verified Steam account does not match");
        }

        localStorage.setItem("greenlandSession", status.token);

        setSessionToken(status.token);
        setSteamVerified(true);

        return;
      }

      throw new Error("Steam verification timed out");
    } catch (error) {
      console.error("Steam verification failed:", error);
    } finally {
      setSteamVerifying(false);
    }
  };

  useEffect(() => {
    if (!steamId || !sessionToken || !steamVerified) {
      nearbyPlayersRef.current = [];

      setNearbyPlayers([]);
      setPlayerPosition(null);

      applyRemoteVolumes();

      return;
    }

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;

    const connectSocket = () => {
      socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        socket?.send(
          JSON.stringify({
            type: "auth",
            token: sessionToken,
          }),
        );
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "authenticated") {
            return;
          }

          if (data.type !== "snapshot") {
            return;
          }

          const snapshot = data as SnapshotMessage;

          if (snapshot.self) {
            setPlayerPosition({
              x: Number(snapshot.self.x),
              y: Number(snapshot.self.y),
              z: Number(snapshot.self.z),
            });
          } else {
            setPlayerPosition(null);
          }

          const nearby = snapshot.nearby || [];

          nearbyPlayersRef.current = nearby;

          setNearbyPlayers(nearby);

          applyRemoteVolumes();
        } catch (error) {
          console.error("Invalid backend message:", error);
        }
      };

      socket.onerror = (error) => {
        console.error("Greenland WebSocket error:", error);
      };

      socket.onclose = (event) => {
        if (event.code === 4001) {
          clearSession();

          return;
        }

        if (!stopped) {
          reconnectTimer = window.setTimeout(() => {
            connectSocket();
          }, 3000);
        }
      };
    };

    connectSocket();

    return () => {
      stopped = true;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
    };
  }, [steamId, sessionToken, steamVerified]);

  useEffect(() => {
    nearbyPlayersRef.current = nearbyPlayers;

    applyRemoteVolumes();
  }, [nearbyPlayers]);

  useEffect(() => {
    if (voiceMode !== "ptt") return;

    let active = true;

    const setupShortcut = async () => {
      try {
        try {
          await unregister("V");
        } catch {}

        await register("V", (event) => {
          if (!active) return;

          if (event.state === "Pressed") {
            if (
              mutedRef.current ||
              micTestActiveRef.current ||
              !roomRef.current
            ) {
              return;
            }

            void setLiveKitMic(true);
          }

          if (event.state === "Released") {
            void setLiveKitMic(false);
          }
        });
      } catch (error) {
        console.error("Unable to register Push to Talk:", error);
      }
    };

    setupShortcut();

    return () => {
      active = false;

      unregister("V").catch(() => {});

      if (voiceModeRef.current === "ptt") {
        void setLiveKitMic(false);
      }
    };
  }, [voiceMode]);

  const startVoiceConnection = async () => {
    if (!steamId || !steamVerified || !sessionToken) {
      return;
    }

    const response = await fetch(`${API_URL}/livekit-token`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearSession();
      }

      const error = await response.text();

      throw new Error(`Token request failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      serverUrl: string;
      token: string;
    };

    const room = new Room();

    room.on(RoomEvent.Connected, () => {
      setVoiceConnected(true);
    });

    room.on(RoomEvent.Disconnected, () => {
      cleanupRemoteAudio();

      setVoiceConnected(false);
      setIsTransmitting(false);

      if (roomRef.current === room) {
        roomRef.current = null;
      }
    });

    room.on(RoomEvent.MediaDevicesError, (error) => {
      console.error("LiveKit media device error:", error);
    });

    room.on(
      RoomEvent.TrackSubscribed,
      async (track, _publication, participant) => {
        if (track.kind !== Track.Kind.Audio) {
          return;
        }

        const remoteSteamId = participant.identity;

        const existingAudio = remoteAudioRef.current.get(remoteSteamId);

        if (existingAudio) {
          existingAudio.pause();
          existingAudio.srcObject = null;
          existingAudio.remove();
        }

        const element = track.attach();

        if (!(element instanceof HTMLAudioElement)) {
          return;
        }

        element.autoplay = true;
        element.volume = 0;
        element.style.display = "none";

        const outputDevice = selectedOutputRef.current;

        if (outputDevice && "setSinkId" in element) {
          try {
            await element.setSinkId(outputDevice);
          } catch (error) {
            console.error("Unable to route remote voice output:", error);
          }
        }

        document.body.appendChild(element);

        remoteAudioRef.current.set(remoteSteamId, element);

        applyRemoteVolumes();

        try {
          await element.play();
        } catch (error) {
          console.warn("Remote voice playback could not start:", error);
        }
      },
    );

    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio) {
        return;
      }

      const remoteSteamId = participant.identity;

      const element = remoteAudioRef.current.get(remoteSteamId);

      if (element) {
        element.pause();
        element.srcObject = null;
        element.remove();

        remoteAudioRef.current.delete(remoteSteamId);
      }

      track.detach();
    });

    roomRef.current = room;

    await room.connect(data.serverUrl, data.token);

    if (selectedInput) {
      await room.switchActiveDevice("audioinput", selectedInput);
    }

    const shouldTransmit =
      voiceModeRef.current === "open" &&
      !mutedRef.current &&
      !micTestActiveRef.current;

    await setLiveKitMic(shouldTransmit);

    try {
      await room.startAudio();
    } catch (error) {
      console.warn("LiveKit audio playback could not start:", error);
    }
  };

  const connectVoice = async () => {
    if (!steamId || !steamVerified || !sessionToken || voiceConnecting) {
      return;
    }

    if (roomRef.current) {
      await setLiveKitMic(false);

      roomRef.current.disconnect();
      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);
      setIsTransmitting(false);

      return;
    }

    try {
      setVoiceConnecting(true);

      await startVoiceConnection();
    } catch (error) {
      console.error("Unable to connect to Greenland voice:", error);

      roomRef.current?.disconnect();
      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);
      setIsTransmitting(false);
    } finally {
      setVoiceConnecting(false);
    }
  };

  const reconnectVoice = async () => {
    if (!steamId || !steamVerified || !sessionToken || reconnecting) {
      return;
    }

    try {
      setReconnecting(true);

      await setLiveKitMic(false);

      roomRef.current?.disconnect();
      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);
      setIsTransmitting(false);

      await startVoiceConnection();
    } catch (error) {
      console.error("Unable to reconnect voice:", error);

      roomRef.current?.disconnect();
      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);
      setIsTransmitting(false);
    } finally {
      setReconnecting(false);
    }
  };

  const changeVoiceMode = async (mode: VoiceMode) => {
    setVoiceMode(mode);
    voiceModeRef.current = mode;

    localStorage.setItem("voiceMode", mode);

    if (!roomRef.current) {
      setIsTransmitting(false);

      return;
    }

    if (mutedRef.current || micTestActiveRef.current) {
      await setLiveKitMic(false);

      return;
    }

    await setLiveKitMic(mode === "open");
  };

  const stopMicTest = async () => {
    micTestAudioRef.current?.pause();

    if (micTestAudioRef.current) {
      micTestAudioRef.current.srcObject = null;
    }

    micTestAudioRef.current = null;

    micTestSourceRef.current?.disconnect();
    micTestSourceRef.current = null;

    micTestDestinationRef.current?.disconnect();
    micTestDestinationRef.current = null;

    if (micTestContextRef.current) {
      await micTestContextRef.current.close();

      micTestContextRef.current = null;
    }

    setMicTestActive(false);
    micTestActiveRef.current = false;

    if (
      roomRef.current &&
      voiceModeRef.current === "open" &&
      !mutedRef.current
    ) {
      await setLiveKitMic(true);
    } else {
      await setLiveKitMic(false);
    }
  };

  const startMicTest = async () => {
    if (!streamRef.current) return;

    try {
      micTestActiveRef.current = true;

      setMicTestActive(true);

      await setLiveKitMic(false);

      const context = new AudioContext();

      const source = context.createMediaStreamSource(streamRef.current);

      const destination = context.createMediaStreamDestination();

      source.connect(destination);

      const audio = new Audio();

      audio.srcObject = destination.stream;

      if (selectedOutputRef.current && "setSinkId" in audio) {
        await audio.setSinkId(selectedOutputRef.current);
      }

      await audio.play();

      micTestContextRef.current = context;
      micTestSourceRef.current = source;
      micTestDestinationRef.current = destination;
      micTestAudioRef.current = audio;
    } catch (error) {
      console.error("Unable to start microphone test:", error);

      micTestActiveRef.current = false;

      setMicTestActive(false);
    }
  };

  const toggleMicTest = async () => {
    if (micTestActive) {
      await stopMicTest();
    } else {
      await startMicTest();
    }
  };

  const changeInput = async (deviceId: string) => {
    if (micTestActiveRef.current) {
      await stopMicTest();
    }

    setSelectedInput(deviceId);

    localStorage.setItem("audioInput", deviceId);

    if (roomRef.current) {
      try {
        await roomRef.current.switchActiveDevice("audioinput", deviceId);
      } catch (error) {
        console.error("Unable to change LiveKit microphone:", error);
      }
    }
  };

  const changeOutput = async (deviceId: string) => {
    setSelectedOutput(deviceId);
    selectedOutputRef.current = deviceId;

    localStorage.setItem("audioOutput", deviceId);

    if (micTestAudioRef.current && "setSinkId" in micTestAudioRef.current) {
      try {
        await micTestAudioRef.current.setSinkId(deviceId);
      } catch (error) {
        console.error("Unable to change microphone test output:", error);
      }
    }

    for (const audio of remoteAudioRef.current.values()) {
      if ("setSinkId" in audio) {
        try {
          await audio.setSinkId(deviceId);
        } catch (error) {
          console.error("Unable to change remote voice output device:", error);
        }
      }
    }
  };

  const toggleMute = async () => {
    const nextMuted = !muted;

    setMuted(nextMuted);
    mutedRef.current = nextMuted;

    if (nextMuted) {
      await setLiveKitMic(false);

      return;
    }

    if (voiceModeRef.current === "open" && !micTestActiveRef.current) {
      await setLiveKitMic(true);
    } else {
      await setLiveKitMic(false);
    }
  };

  const openSupport = async () => {
    try {
      await openUrl(SUPPORT_URL);
    } catch (error) {
      console.error("Unable to open Discord support:", error);
    }
  };

  useEffect(() => {
    return () => {
      micTestAudioRef.current?.pause();

      if (micTestContextRef.current) {
        micTestContextRef.current.close();
      }

      unregister("V").catch(() => {});

      cleanupRemoteAudio();

      roomRef.current?.disconnect();
    };
  }, []);

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">G</div>

          <div>
            <div className="brand-title">Greenland Voice</div>

            <div className="brand-subtitle">PROXIMITY VOICE</div>
          </div>
        </div>

        <div className="topbar-right">
          <div
            className={`voice-status ${
              voiceConnected
                ? "online"
                : voiceConnecting
                  ? "waiting"
                  : "offline"
            }`}
          >
            <span />

            {voiceConnecting
              ? "Connecting"
              : voiceConnected
                ? "Connected"
                : "Disconnected"}
          </div>

          {steamId && !steamVerified && (
            <button
              className="verify-steam"
              onClick={verifySteam}
              disabled={steamVerifying}
            >
              {steamVerifying ? "Waiting for Steam..." : "Verify with Steam"}
            </button>
          )}

          <button
            className="restart-button"
            onClick={reconnectVoice}
            disabled={
              reconnecting || voiceConnecting || !steamVerified || !sessionToken
            }
          >
            ↻ {reconnecting ? "Reconnecting" : "Reconnect"}
          </button>

          {voiceConnected && (
            <button className="stop-button" onClick={connectVoice}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      <div className="hidden-status-row">
        <div className="mini-status tooltip-parent">
          <span
            className={`mini-dot ${
              steamVerified ? "online" : steamId ? "waiting" : "offline"
            }`}
          />

          {steamVerified
            ? "Steam Verified"
            : steamId
              ? "Steam Detected"
              : "Steam"}

          <Tooltip
            title={
              steamVerified
                ? "Steam verified"
                : steamId
                  ? "Verification required"
                  : "Steam not detected"
            }
            body={
              steamVerified
                ? "Your Steam identity has been securely verified."
                : steamId
                  ? "Verify with Steam before connecting to voice."
                  : "Open Steam and make sure you are signed in."
            }
          />
        </div>

        <div className="mini-status tooltip-parent">
          <span className={`mini-dot ${gamePid ? "online" : "offline"}`} />
          The Isle
          <Tooltip
            title={gamePid ? "The Isle is running" : "The Isle is not running"}
            body={
              gamePid
                ? "Game detection is active."
                : "Launch The Isle to enable player tracking."
            }
          />
        </div>

        <div className="mini-status tooltip-parent">
          <span
            className={`mini-dot ${playerPosition ? "online" : "waiting"}`}
          />
          Tracking
          <Tooltip
            title={
              playerPosition ? "Position detected" : "Waiting for position"
            }
            body={
              playerPosition
                ? "Your coordinates are updating."
                : "Join Greenland PH to begin proximity tracking."
            }
          />
        </div>
      </div>

      <div className="main-grid">
        <section className="voice-panel">
          <div className="panel-heading">
            <div>
              <span className="section-label">Voice Settings</span>

              <h2>Microphone & Audio</h2>
            </div>

            <div
              className={`transmit-status ${
                muted ? "muted" : isTransmitting ? "active" : ""
              }`}
            >
              <span />

              {muted ? "Muted" : isTransmitting ? "Transmitting" : "Idle"}
            </div>
          </div>

          <div className="voice-mode-row">
            <button
              className={`mode-button ${voiceMode === "open" ? "active" : ""}`}
              onClick={() => changeVoiceMode("open")}
            >
              <strong>Open Mic</strong>
              <span>Always transmit</span>
            </button>

            <button
              className={`mode-button ${voiceMode === "ptt" ? "active" : ""}`}
              onClick={() => changeVoiceMode("ptt")}
            >
              <strong>Push to Talk</strong>
              <span>Hold V to speak</span>
            </button>
          </div>

          {voiceMode === "ptt" && (
            <div className="ptt-setting">
              <div>
                <strong>Push to Talk Key</strong>

                <span>Works while The Isle is focused</span>
              </div>

              <kbd>V</kbd>
            </div>
          )}

          <div className="device-grid">
            <label>
              <span className="field-label">Microphone</span>

              <select
                value={selectedInput}
                onChange={(event) => changeInput(event.target.value)}
              >
                {inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="field-label">Output Device</span>

              <select
                value={selectedOutput}
                onChange={(event) => changeOutput(event.target.value)}
              >
                {outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mic-controls">
            <div className="level-section">
              <div className="level-header">
                <span>Mic Level</span>

                <span>{Math.round(micLevel)}%</span>
              </div>

              <div className="meter">
                <div
                  className="meter-fill"
                  style={{
                    width: `${micLevel}%`,
                  }}
                />
              </div>
            </div>

            <button
              className={`utility-button ${micTestActive ? "active" : ""}`}
              onClick={toggleMicTest}
            >
              {micTestActive ? "Stop Test" : "Mic Test"}
            </button>

            <button
              className={`mute-button ${muted ? "active" : ""}`}
              onClick={toggleMute}
            >
              {muted ? "Unmute Mic" : "Mute Mic"}
            </button>
          </div>

          {micTestActive && (
            <div className="info-message">
              You are hearing your microphone locally. Voice transmission is
              paused during the test.
            </div>
          )}
        </section>

        <aside className="side-panel">
          <section className="position-card">
            <div className="card-title-row">
              <div>
                <span className="section-label">Player Position</span>

                <h3>Current Coordinates</h3>
              </div>

              <span className={`live-badge ${playerPosition ? "online" : ""}`}>
                <span />

                {playerPosition ? "Live" : "Waiting"}
              </span>
            </div>

            {playerPosition ? (
              <div className="coordinates">
                <div>
                  <span>X</span>
                  <strong>{playerPosition.x.toFixed(0)}</strong>
                </div>

                <div>
                  <span>Y</span>
                  <strong>{playerPosition.y.toFixed(0)}</strong>
                </div>

                <div>
                  <span>Z</span>
                  <strong>{playerPosition.z.toFixed(0)}</strong>
                </div>
              </div>
            ) : (
              <div className="empty-box">Waiting for player position</div>
            )}
          </section>

          <section className="support-card">
            <span className="section-label">Support</span>

            <h3>Having problems?</h3>

            <p>
              Reconnect voice first. If the problem continues, open the
              Greenland PH support channel.
            </p>

            <div className="support-actions">
              <button
                className="utility-button"
                onClick={reconnectVoice}
                disabled={
                  reconnecting ||
                  voiceConnecting ||
                  !steamVerified ||
                  !sessionToken
                }
              >
                Reconnect
              </button>

              <button className="discord-button" onClick={openSupport}>
                Discord Support
              </button>
            </div>
          </section>
        </aside>
      </div>

      <section className="players-panel">
        <div className="players-header">
          <div>
            <span className="section-label">Proximity</span>

            <h2>Nearby Players</h2>
          </div>

          <div className="players-count">{nearbyPlayers.length}</div>
        </div>

        <div className="players-list">
          {nearbyPlayers.length > 0 ? (
            nearbyPlayers.map((player) => (
              <div className="player-item" key={player.steamId}>
                <span className="player-status" />

                <span>{player.name}</span>
              </div>
            ))
          ) : (
            <div className="players-empty">
              No players currently in voice range
            </div>
          )}
        </div>
      </section>

      {!voiceConnected && (
        <button
          className="connect-button"
          onClick={connectVoice}
          disabled={
            voiceConnecting ||
            reconnecting ||
            !steamId ||
            !steamVerified ||
            !sessionToken
          }
        >
          {!steamVerified
            ? "Verify Steam to Connect"
            : voiceConnecting
              ? "Connecting..."
              : "Connect Voice"}
        </button>
      )}
    </main>
  );
}

export default App;
