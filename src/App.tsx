import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { listen } from "@tauri-apps/api/event";

import { openUrl } from "@tauri-apps/plugin-opener";

import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Info,
  LogOut,
  RotateCw,
  X,
} from "lucide-react";

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

type PttBinding = {
  type: "keyboard" | "mouse";

  value: string;
};

type TooltipProps = {
  title: string;
  body: string;
};

type ToastType = "error" | "success" | "info";

type ToastState = {
  id: number;
  type: ToastType;
  title: string;
  message: string;
};

type DeviceDropdownProps = {
  label: string;
  devices: Device[];
  value: string;
  emptyLabel: string;

  onChange: (deviceId: string) => void | Promise<void>;
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

function HeaderTooltip({ title, body }: TooltipProps) {
  return (
    <div className="header-tooltip">
      <strong>{title}</strong>

      <span>{body}</span>
    </div>
  );
}

function DeviceDropdown({
  label,
  devices,
  value,
  emptyLabel,
  onChange,
}: DeviceDropdownProps) {
  const [open, setOpen] = useState(false);

  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const selectedDevice = devices.find((device) => device.deviceId === value);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);

      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const selectDevice = async (deviceId: string) => {
    await onChange(deviceId);

    setOpen(false);
  };

  return (
    <div className="device-field" ref={dropdownRef}>
      <span className="field-label">{label}</span>

      <div className={`device-dropdown ${open ? "open" : ""}`}>
        <button
          type="button"
          className="device-dropdown-trigger"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          disabled={devices.length === 0}
        >
          <span className="device-dropdown-value">
            {selectedDevice?.label ||
              (devices.length === 0 ? emptyLabel : "Select device")}
          </span>

          <ChevronDown
            className="device-dropdown-chevron"
            size={15}
            strokeWidth={1.8}
          />
        </button>

        {open && (
          <div className="device-dropdown-menu">
            <div className="device-dropdown-scroll">
              {devices.length > 0 ? (
                devices.map((device) => {
                  const selected = device.deviceId === value;

                  return (
                    <button
                      type="button"
                      className={`device-dropdown-option ${
                        selected ? "selected" : ""
                      }`}
                      key={device.deviceId}
                      onClick={() => void selectDevice(device.deviceId)}
                    >
                      <span>{device.label}</span>

                      {selected && <Check size={14} strokeWidth={2} />}
                    </button>
                  );
                })
              ) : (
                <div className="device-dropdown-empty">No devices found</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function loadPttBinding(): PttBinding {
  const saved = localStorage.getItem("pttBinding");

  if (saved) {
    try {
      const parsed = JSON.parse(saved);

      if (
        (parsed.type === "keyboard" || parsed.type === "mouse") &&
        typeof parsed.value === "string"
      ) {
        return parsed;
      }
    } catch {}
  }

  const oldKey = localStorage.getItem("pttKey");

  if (oldKey) {
    return {
      type: "keyboard",

      value: oldKey,
    };
  }

  return {
    type: "keyboard",

    value: "V",
  };
}

function formatPttKey(key: string) {
  if (key === " ") return "Space";
  if (key === "Control") return "Ctrl";
  if (key === "Escape") return "Escape";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key === "PageUp") return "PageUp";
  if (key === "PageDown") return "PageDown";
  if (key === "CapsLock") return "CapsLock";
  if (key.length === 1) return key.toUpperCase();
  return key;
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

  const [pttBinding, setPttBinding] = useState<PttBinding>(loadPttBinding);

  const [listeningForPttKey, setListeningForPttKey] = useState(false);

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

  const [toast, setToast] = useState<ToastState | null>(null);

  const toastTimerRef = useRef<number | null>(null);

  const lastToastRef = useRef<{ message: string; shownAt: number } | null>(
    null,
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

  const pttBindingRef = useRef<PttBinding>(pttBinding);

  const listeningForPttRef = useRef(listeningForPttKey);

  const pttPressedRef = useRef(false);

  const micTestContextRef = useRef<AudioContext | null>(null);

  const micTestSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const micTestDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null,
  );

  const micTestAudioRef = useRef<HTMLAudioElement | null>(null);

  const canConnectVoice =
    !!steamId &&
    steamVerified &&
    !!sessionToken &&
    !!gamePid &&
    !!playerPosition;

  const showToast = (
    type: ToastType,
    title: string,
    message: string,
    duration = 4200,
  ) => {
    const now = Date.now();
    const last = lastToastRef.current;

    if (last && last.message === message && now - last.shownAt < 5000) {
      return;
    }

    lastToastRef.current = { message, shownAt: now };

    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast({
      id: now,
      type,
      title,
      message,
    });

    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  };

  const dismissToast = () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }

    setToast(null);
  };

  const getErrorMessage = (error: unknown, fallback: string) => {
    return error instanceof Error && error.message ? error.message : fallback;
  };

  const savePttBinding = (binding: PttBinding) => {
    setPttBinding(binding);

    pttBindingRef.current = binding;

    localStorage.setItem("pttBinding", JSON.stringify(binding));

    localStorage.removeItem("pttKey");
  };

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
    pttBindingRef.current = pttBinding;
  }, [pttBinding]);

  useEffect(() => {
    listeningForPttRef.current = listeningForPttKey;
  }, [listeningForPttKey]);

  useEffect(() => {
    let initialized = false;
    let previousInputs: Device[] = [];
    let previousOutputs: Device[] = [];
    let refreshRunning = false;

    const getDeviceLabel = (device: Device, fallback: string) =>
      device.label || fallback;

    const refreshDevices = async (announceChanges: boolean) => {
      if (refreshRunning) {
        return;
      }

      refreshRunning = true;

      try {
        if (!initialized) {
          const permissionStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });

          permissionStream.getTracks().forEach((track) => track.stop());
        }

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

        if (initialized && announceChanges) {
          const previousInputIds = new Set(
            previousInputs.map((device) => device.deviceId),
          );
          const previousOutputIds = new Set(
            previousOutputs.map((device) => device.deviceId),
          );
          const nextInputIds = new Set(
            inputDevices.map((device) => device.deviceId),
          );
          const nextOutputIds = new Set(
            outputDevices.map((device) => device.deviceId),
          );

          const connectedInputs = inputDevices.filter(
            (device) => !previousInputIds.has(device.deviceId),
          );
          const disconnectedInputs = previousInputs.filter(
            (device) => !nextInputIds.has(device.deviceId),
          );
          const connectedOutputs = outputDevices.filter(
            (device) => !previousOutputIds.has(device.deviceId),
          );
          const disconnectedOutputs = previousOutputs.filter(
            (device) => !nextOutputIds.has(device.deviceId),
          );

          const changes: string[] = [];

          for (const device of connectedInputs) {
            changes.push(
              `Microphone connected: ${getDeviceLabel(device, "Microphone")}`,
            );
          }

          for (const device of disconnectedInputs) {
            changes.push(
              `Microphone disconnected: ${getDeviceLabel(device, "Microphone")}`,
            );
          }

          for (const device of connectedOutputs) {
            changes.push(
              `Output connected: ${getDeviceLabel(device, "Output Device")}`,
            );
          }

          for (const device of disconnectedOutputs) {
            changes.push(
              `Output disconnected: ${getDeviceLabel(device, "Output Device")}`,
            );
          }

          if (changes.length > 0) {
            const onlyConnected =
              disconnectedInputs.length === 0 &&
              disconnectedOutputs.length === 0;
            const onlyDisconnected =
              connectedInputs.length === 0 && connectedOutputs.length === 0;

            showToast(
              onlyDisconnected ? "error" : onlyConnected ? "success" : "info",
              onlyDisconnected
                ? "Audio device disconnected"
                : onlyConnected
                  ? "Audio device connected"
                  : "Audio devices changed",
              changes.join(" • "),
              5200,
            );
          }
        }

        setInputs(inputDevices);
        setOutputs(outputDevices);

        const selectedInputStillExists = inputDevices.some(
          (device) => device.deviceId === selectedInput,
        );
        const selectedOutputStillExists = outputDevices.some(
          (device) => device.deviceId === selectedOutputRef.current,
        );

        if (!selectedInputStillExists) {
          const fallbackInput = inputDevices[0]?.deviceId || "";
          setSelectedInput(fallbackInput);

          if (fallbackInput) {
            localStorage.setItem("audioInput", fallbackInput);

            if (roomRef.current) {
              try {
                await roomRef.current.switchActiveDevice(
                  "audioinput",
                  fallbackInput,
                );
              } catch (error) {
                console.error("Unable to switch fallback microphone:", error);
              }
            }
          } else {
            localStorage.removeItem("audioInput");
            setMicLevel(0);
            await setLiveKitMic(false);
          }
        }

        if (!selectedOutputStillExists) {
          const fallbackOutput = outputDevices[0]?.deviceId || "";
          setSelectedOutput(fallbackOutput);
          selectedOutputRef.current = fallbackOutput;

          if (fallbackOutput) {
            localStorage.setItem("audioOutput", fallbackOutput);

            for (const audio of remoteAudioRef.current.values()) {
              if ("setSinkId" in audio) {
                try {
                  await audio.setSinkId(fallbackOutput);
                } catch (error) {
                  console.error("Unable to switch fallback output:", error);
                }
              }
            }
          } else {
            localStorage.removeItem("audioOutput");
          }
        }

        previousInputs = inputDevices;
        previousOutputs = outputDevices;
        initialized = true;
      } catch (error) {
        console.error("Unable to load audio devices:", error);

        const permissionDenied =
          error instanceof DOMException && error.name === "NotAllowedError";

        showToast(
          "error",
          "Microphone unavailable",
          permissionDenied
            ? "Microphone permission was denied. Allow microphone access and restart Greenland Voice."
            : "Greenland Voice couldn't load your audio devices.",
        );
      } finally {
        refreshRunning = false;
      }
    };

    const handleDeviceChange = () => {
      void refreshDevices(true);
    };

    void refreshDevices(false);

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, []);

  useEffect(() => {
    if (!selectedInput) {
      return;
    }

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

        showToast(
          "error",
          "Microphone unavailable",
          "The selected microphone couldn't be started. Try selecting another microphone.",
        );
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

          showToast(
            "info",
            "Steam verification expired",
            "Verify with Steam again to continue using Greenland Voice.",
          );

          return;
        }

        const data = (await response.json()) as {
          authenticated: boolean;

          steamId?: string;
        };

        if (!data.authenticated || !data.steamId || data.steamId !== steamId) {
          clearSession();

          showToast(
            "error",
            "Steam account mismatch",
            "Your verified Steam session doesn't match the Steam account detected on this PC.",
          );

          return;
        }

        setSteamVerified(true);
      } catch (error) {
        console.error("Unable to validate Steam session:", error);

        showToast(
          "error",
          "Backend unavailable",
          "Greenland Voice couldn't reach the server. Check your connection and try again.",
        );
      }
    };

    validateSession();
  }, [sessionToken, steamId]);

  const verifySteam = async () => {
    if (!steamId || steamVerifying) {
      return;
    }

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

        showToast(
          "success",
          "Steam verified",
          "Your Steam account is now connected to Greenland Voice.",
        );

        return;
      }

      throw new Error("Steam verification timed out");
    } catch (error) {
      console.error("Steam verification failed:", error);

      showToast(
        "error",
        "Steam verification failed",
        getErrorMessage(error, "Steam verification couldn't be completed."),
      );
    } finally {
      setSteamVerifying(false);
    }
  };

  const logoutSteam = async () => {
    try {
      await setLiveKitMic(false);

      roomRef.current?.disconnect();

      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);

      setIsTransmitting(false);

      if (sessionToken) {
        await fetch(`${API_URL}/auth/logout`, {
          method: "POST",

          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
      }
    } catch (error) {
      console.error("Unable to log out:", error);
    } finally {
      clearSession();

      setPlayerPosition(null);

      setNearbyPlayers([]);

      nearbyPlayersRef.current = [];

      showToast(
        "success",
        "Logged out",
        "You've been logged out of Greenland Voice.",
      );
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

          showToast(
            "info",
            "Session expired",
            "Your Greenland Voice session expired. Verify with Steam again.",
          );

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
    if (!listeningForPttKey) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) {
        return;
      }

      if (event.key === "Escape") {
        listeningForPttRef.current = false;
        setListeningForPttKey(false);
        return;
      }

      const value = formatPttKey(event.key);

      savePttBinding({
        type: "keyboard",
        value,
      });

      listeningForPttRef.current = false;
      setListeningForPttKey(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [listeningForPttKey]);

  useEffect(() => {
    const keyboardKey =
      voiceMode === "ptt" && pttBinding.type === "keyboard"
        ? pttBinding.value
        : null;

    invoke("set_ptt_keyboard_key", { key: keyboardKey }).catch((error) => {
      console.error("Unable to configure keyboard Push to Talk:", error);

      if (keyboardKey) {
        showToast(
          "error",
          "Push to Talk unavailable",
          `The ${keyboardKey} key isn't supported for Push to Talk.`,
        );
      }
    });

    return () => {
      void invoke("set_ptt_keyboard_key", { key: null });
    };
  }, [voiceMode, pttBinding]);

  useEffect(() => {
    let unlistenKeyboard: (() => void) | undefined;
    let unlistenMouse: (() => void) | undefined;

    const handlePttState = (type: PttBinding["type"], payload: string) => {
      const [value, state] = payload.split(":");

      if (!value || (state !== "pressed" && state !== "released")) {
        return;
      }

      if (type === "mouse" && listeningForPttRef.current) {
        if (state !== "pressed") {
          return;
        }

        savePttBinding({
          type: "mouse",
          value,
        });

        listeningForPttRef.current = false;
        setListeningForPttKey(false);
        return;
      }

      const binding = pttBindingRef.current;

      if (
        voiceModeRef.current !== "ptt" ||
        binding.type !== type ||
        binding.value !== value
      ) {
        return;
      }

      if (state === "pressed") {
        if (pttPressedRef.current) {
          return;
        }

        pttPressedRef.current = true;

        if (mutedRef.current || micTestActiveRef.current || !roomRef.current) {
          return;
        }

        void setLiveKitMic(true);
        return;
      }

      if (!pttPressedRef.current) {
        return;
      }

      pttPressedRef.current = false;
      void setLiveKitMic(false);
    };

    listen<string>("ptt-keyboard", (event) => {
      handlePttState("keyboard", event.payload);
    }).then((stop) => {
      unlistenKeyboard = stop;
    });

    listen<string>("ptt-mouse", (event) => {
      handlePttState("mouse", event.payload);
    }).then((stop) => {
      unlistenMouse = stop;
    });

    return () => {
      unlistenKeyboard?.();
      unlistenMouse?.();
      pttPressedRef.current = false;
      void setLiveKitMic(false);
    };
  }, []);

  const startVoiceConnection = async () => {
    if (
      !steamId ||
      !steamVerified ||
      !sessionToken ||
      !gamePid ||
      !playerPosition
    ) {
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

        throw new Error("Your Steam session expired. Verify with Steam again.");
      }

      if (response.status === 403) {
        throw new Error(
          "Join Greenland PH in The Isle before connecting to voice.",
        );
      }

      throw new Error("The voice server couldn't authorize your connection.");
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

      showToast(
        "error",
        "Audio device error",
        "Live voice lost access to your microphone. Check the selected device and permissions.",
      );
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

            showToast(
              "error",
              "Output device unavailable",
              "Remote voice couldn't be routed to the selected output device.",
            );
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
    if (roomRef.current) {
      await setLiveKitMic(false);

      roomRef.current.disconnect();

      roomRef.current = null;

      cleanupRemoteAudio();

      setVoiceConnected(false);

      setIsTransmitting(false);

      return;
    }

    if (!canConnectVoice || voiceConnecting) {
      return;
    }

    try {
      setVoiceConnecting(true);

      await startVoiceConnection();
    } catch (error) {
      console.error("Unable to connect to Greenland voice:", error);

      showToast(
        "error",
        "Voice connection failed",
        getErrorMessage(
          error,
          "Greenland Voice couldn't connect. Check your connection and try again.",
        ),
      );

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
    if (!canConnectVoice || reconnecting) {
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

      showToast(
        "error",
        "Reconnect failed",
        getErrorMessage(
          error,
          "Greenland Voice couldn't reconnect. Check your connection and try again.",
        ),
      );

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
    if (!streamRef.current) {
      return;
    }

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

      showToast(
        "error",
        "Mic test failed",
        "Greenland Voice couldn't start the microphone test with the selected devices.",
      );

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

      showToast(
        "error",
        "Couldn't open Discord",
        "The support link couldn't be opened.",
      );
    }
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }

      micTestAudioRef.current?.pause();

      if (micTestContextRef.current) {
        micTestContextRef.current.close();
      }

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

            <div className="brand-subtitle">v.1.0.0</div>
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

          <div className="header-tooltip-parent">
            <button
              className={`header-icon-button ${reconnecting ? "spinning" : ""}`}
              onClick={reconnectVoice}
              disabled={reconnecting || voiceConnecting || !canConnectVoice}
              aria-label="Reconnect Voice"
            >
              <RotateCw size={16} strokeWidth={1.8} />
            </button>

            <HeaderTooltip
              title="Reconnect Voice"
              body={
                canConnectVoice
                  ? "Reconnect to the voice server."
                  : "Join Greenland PH before reconnecting."
              }
            />
          </div>

          {steamVerified && (
            <div className="header-tooltip-parent">
              <button
                className="header-icon-button logout-icon-button"
                onClick={logoutSteam}
                aria-label="Log out"
              >
                <LogOut size={16} strokeWidth={1.8} />
              </button>

              <HeaderTooltip
                title="Log out"
                body="Log out of Greenland Voice. This does not sign you out of Steam."
              />
            </div>
          )}

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
                ? "You are connected to Greenland PH and your position is updating."
                : gamePid
                  ? "Join Greenland PH to begin proximity tracking."
                  : "Launch The Isle and join Greenland PH."
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

              <span>Hold your key to speak</span>
            </button>
          </div>

          {voiceMode === "ptt" && (
            <div className="ptt-setting">
              <div>
                <strong>Push to Talk Key</strong>

                <span>
                  {listeningForPttKey
                    ? "Press a keyboard key or mouse side button — Esc to cancel"
                    : "Click the key to change it"}
                </span>
              </div>

              <button
                className={`ptt-key-button ${
                  listeningForPttKey ? "listening" : ""
                }`}
                onClick={() => setListeningForPttKey(true)}
              >
                {listeningForPttKey ? "..." : pttBinding.value}
              </button>
            </div>
          )}

          <div className="device-grid">
            <DeviceDropdown
              label="Microphone"
              devices={inputs}
              value={selectedInput}
              emptyLabel="No microphone connected"
              onChange={changeInput}
            />

            <DeviceDropdown
              label="Output Device"
              devices={outputs}
              value={selectedOutput}
              emptyLabel="No output device connected"
              onChange={changeOutput}
            />
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
              <div className="empty-box">
                {!gamePid
                  ? "Launch The Isle"
                  : "Join Greenland PH to begin tracking"}
              </div>
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
                disabled={reconnecting || voiceConnecting || !canConnectVoice}
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
              {!gamePid
                ? "Launch The Isle to use proximity voice"
                : !playerPosition
                  ? "Join Greenland PH to see nearby players"
                  : "No players currently in voice range"}
            </div>
          )}
        </div>
      </section>

      {!voiceConnected && (
        <button
          className="connect-button"
          onClick={connectVoice}
          disabled={voiceConnecting || reconnecting || !canConnectVoice}
        >
          {!steamVerified
            ? "Verify Steam to Connect"
            : !gamePid
              ? "Launch The Isle to Connect"
              : !playerPosition
                ? "Join Greenland PH to Connect"
                : voiceConnecting
                  ? "Connecting..."
                  : "Connect Voice"}
        </button>
      )}

      {toast && (
        <div className="toast-region" role="status" aria-live="polite">
          <div className={`app-toast ${toast.type}`} key={toast.id}>
            <div className="toast-icon" aria-hidden="true">
              {toast.type === "error" ? (
                <AlertCircle size={17} strokeWidth={1.9} />
              ) : toast.type === "success" ? (
                <CheckCircle2 size={17} strokeWidth={1.9} />
              ) : (
                <Info size={17} strokeWidth={1.9} />
              )}
            </div>

            <div className="toast-copy">
              <strong>{toast.title}</strong>
              <span>{toast.message}</span>
            </div>

            <button
              type="button"
              className="toast-close"
              onClick={dismissToast}
              aria-label="Dismiss notification"
            >
              <X size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
