import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Room, RoomEvent } from "livekit-client";
import "./App.css";

type Device = {
  deviceId: string;
  label: string;
};

function App() {
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);

  const [selectedInput, setSelectedInput] = useState(
    localStorage.getItem("audioInput") || "",
  );

  const [selectedOutput, setSelectedOutput] = useState(
    localStorage.getItem("audioOutput") || "",
  );

  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [gamePid, setGamePid] = useState<number | null>(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);

  const [playerPosition, setPlayerPosition] = useState<{
    x: number;
    y: number;
    z: number;
  } | null>(null);

  const [nearbyPlayers, setNearbyPlayers] = useState<
    {
      name: string;
      steamId: string;
      distance: number;
      volume: number;
    }[]
  >([]);

  const [steamId, setSteamId] = useState<string | null>(null);

  const [testMode, setTestMode] = useState(false);
  const [testPan, setTestPan] = useState(0);
  const [fakePlayerOffset, setFakePlayerOffset] = useState(1000);

  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);

  const roomRef = useRef<Room | null>(null);

  const testAudioContextRef = useRef<AudioContext | null>(null);
  const testSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const testGainRef = useRef<GainNode | null>(null);
  const testPannerRef = useRef<StereoPannerNode | null>(null);
  const testDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null,
  );

  const testAudioRef = useRef<HTMLAudioElement | null>(null);

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
        console.log("Detected SteamID:", detectedSteamId);
        setSteamId(detectedSteamId);
      })
      .catch((error) => {
        console.error("SteamID detection failed:", error);
      });

    const interval = setInterval(checkGame, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!steamId) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;

    const connectBackend = () => {
      socket = new WebSocket("wss://greenland-voice.onrender.com/ws");

      socket.onopen = () => {
        console.log("Connected to Greenland backend");
        setBackendConnected(true);
      };

      socket.onerror = (error) => {
        console.error("Greenland backend WebSocket error:", error);
      };

      socket.onclose = () => {
        console.log("Disconnected from Greenland backend");
        setBackendConnected(false);

        if (!stopped) {
          reconnectTimer = window.setTimeout(() => {
            console.log("Reconnecting to Greenland backend...");

            connectBackend();
          }, 3000);
        }
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "players" && data.players.length > 0) {
          const player = data.players.find(
            (player: { steamId: string }) => player.steamId === steamId,
          );

          if (player) {
            const x = Number(player.x);
            const y = Number(player.y);
            const z = Number(player.z);

            setPlayerPosition({
              x,
              y,
              z,
            });

            const others = data.players
              .filter((other: { steamId: string }) => other.steamId !== steamId)
              .map(
                (other: {
                  name: string;
                  steamId: string;
                  x: number;
                  y: number;
                  z: number;
                }) => {
                  const dx = x - Number(other.x);
                  const dy = y - Number(other.y);
                  const dz = z - Number(other.z);

                  const rawDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                  const maxVoiceDistance = 5000;

                  const normalizedDistance = Math.min(
                    rawDistance / maxVoiceDistance,
                    1,
                  );

                  const volume = Math.pow(1 - normalizedDistance, 1.6);

                  return {
                    name: other.name,
                    steamId: other.steamId,
                    distance: rawDistance,
                    volume,
                  };
                },
              )
              .filter((player: { volume: number }) => player.volume > 0);

            setNearbyPlayers(others);

            if (testMode) {
              const fakeDistance = Math.abs(fakePlayerOffset);

              const normalizedDistance = Math.min(fakeDistance / 5000, 1);

              const volume = Math.pow(1 - normalizedDistance, 1.6);

              setNearbyPlayers([
                ...others,
                {
                  name: "Test Player",
                  steamId: "test-player",
                  distance: fakeDistance,
                  volume,
                },
              ]);
            }
          }
        }
      };
    };

    connectBackend();

    return () => {
      stopped = true;

      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }

      socket?.close();
    };
  }, [steamId]);

  const connectVoice = async () => {
    if (!steamId) {
      console.error("Cannot connect voice: SteamID missing");
      return;
    }

    if (voiceConnecting) return;

    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
      setVoiceConnected(false);
      return;
    }

    try {
      setVoiceConnecting(true);

      const response = await fetch(
        `https://greenland-voice.onrender.com/livekit-token?steamId=${encodeURIComponent(
          steamId,
        )}`,
      );

      if (!response.ok) {
        const error = await response.text();

        throw new Error(`Token request failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as {
        serverUrl: string;
        token: string;
      };

      const room = new Room();

      room.on(RoomEvent.Connected, () => {
        console.log("Connected to Greenland voice");
        setVoiceConnected(true);
      });

      room.on(RoomEvent.Disconnected, () => {
        console.log("Disconnected from Greenland voice");
        setVoiceConnected(false);
        roomRef.current = null;
      });

      room.on(RoomEvent.MediaDevicesError, (error) => {
        console.error("LiveKit media device error:", error);
      });

      roomRef.current = room;

      await room.connect(data.serverUrl, data.token);

      if (selectedInput) {
        await room.switchActiveDevice("audioinput", selectedInput);
      }

      await room.localParticipant.setMicrophoneEnabled(!muted);

      try {
        await room.startAudio();
      } catch (error) {
        console.warn("LiveKit audio playback could not start:", error);
      }
    } catch (error) {
      console.error("Unable to connect to Greenland voice:", error);

      roomRef.current?.disconnect();
      roomRef.current = null;
      setVoiceConnected(false);
    } finally {
      setVoiceConnecting(false);
    }
  };

  const changeInput = async (deviceId: string) => {
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

  const changeOutput = (deviceId: string) => {
    setSelectedOutput(deviceId);
    localStorage.setItem("audioOutput", deviceId);

    if (testAudioRef.current && "setSinkId" in testAudioRef.current) {
      testAudioRef.current.setSinkId(deviceId).catch((error) => {
        console.error("Unable to change output device:", error);
      });
    }
  };

  const toggleMute = async () => {
    const nextMuted = !muted;

    setMuted(nextMuted);

    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });

    if (roomRef.current) {
      try {
        await roomRef.current.localParticipant.setMicrophoneEnabled(!nextMuted);
      } catch (error) {
        console.error("Unable to change LiveKit microphone state:", error);
      }
    }
  };

  const activeTestDistance = fakePlayerOffset;

  const normalizedDistance = Math.min(activeTestDistance / 5000, 1);

  const proximityVolume = Math.pow(1 - normalizedDistance, 1.6);

  useEffect(() => {
    if (testGainRef.current) {
      testGainRef.current.gain.value = proximityVolume;
    }
  }, [proximityVolume]);

  useEffect(() => {
    if (testPannerRef.current) {
      testPannerRef.current.pan.value = testPan / 100;
    }
  }, [testPan]);

  const stopTestMode = async () => {
    testAudioRef.current?.pause();
    testAudioRef.current = null;

    testSourceRef.current?.disconnect();
    testSourceRef.current = null;

    testGainRef.current?.disconnect();
    testGainRef.current = null;

    testPannerRef.current?.disconnect();
    testPannerRef.current = null;

    testDestinationRef.current?.disconnect();
    testDestinationRef.current = null;

    if (testAudioContextRef.current) {
      await testAudioContextRef.current.close();
      testAudioContextRef.current = null;
    }

    setTestMode(false);
  };

  const startTestMode = async () => {
    if (!streamRef.current) return;

    try {
      const audioContext = new AudioContext();

      const source = audioContext.createMediaStreamSource(streamRef.current);

      const gain = audioContext.createGain();
      const panner = audioContext.createStereoPanner();

      const destination = audioContext.createMediaStreamDestination();

      gain.gain.value = proximityVolume;
      panner.pan.value = testPan / 100;

      source.connect(gain);
      gain.connect(panner);
      panner.connect(destination);

      const audio = new Audio();

      audio.srcObject = destination.stream;

      if ("setSinkId" in audio && selectedOutput) {
        await audio.setSinkId(selectedOutput);
      }

      await audio.play();

      testAudioContextRef.current = audioContext;
      testSourceRef.current = source;
      testGainRef.current = gain;
      testPannerRef.current = panner;
      testDestinationRef.current = destination;
      testAudioRef.current = audio;

      setTestMode(true);
    } catch (error) {
      console.error("Unable to start proximity test:", error);
    }
  };

  const toggleTestMode = async () => {
    if (testMode) {
      await stopTestMode();
    } else {
      await startTestMode();
    }
  };

  useEffect(() => {
    return () => {
      testAudioRef.current?.pause();

      if (testAudioContextRef.current) {
        testAudioContextRef.current.close();
      }

      roomRef.current?.disconnect();
    };
  }, []);

  return (
    <main className="app">
      <h1>GREENLAND VOICE</h1>

      <div className="status">
        <span className={`dot ${backendConnected ? "online" : ""}`} />
        Backend: {backendConnected ? "Connected" : "Disconnected"}
      </div>

      <div className="status">
        <span className={`dot ${voiceConnected ? "online" : ""}`} />
        Voice:{" "}
        {voiceConnecting
          ? "Connecting..."
          : voiceConnected
            ? "Connected"
            : "Disconnected"}
      </div>

      <div className="status">
        <span className={`dot ${gamePid ? "online" : ""}`} />
        The Isle: {gamePid ? `Detected (${gamePid})` : "Not Running"}
      </div>

      {playerPosition && (
        <div className="status">
          X: {playerPosition.x.toFixed(0)} | Y: {playerPosition.y.toFixed(0)} |
          Z: {playerPosition.z.toFixed(0)}
        </div>
      )}

      {nearbyPlayers.map((player) => (
        <div key={player.steamId} className="status">
          {player.name}: {player.distance.toFixed(0)} units |{" "}
          {Math.round(player.volume * 100)}%
        </div>
      ))}

      <div className="panel">
        <label>
          Microphone
          <select
            value={selectedInput}
            onChange={(e) => changeInput(e.target.value)}
          >
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>

        <div className="meter">
          <div
            className="meter-fill"
            style={{
              width: `${micLevel}%`,
            }}
          />
        </div>

        <button onClick={toggleMute}>
          {muted ? "Unmute Mic" : "Mute Mic"}
        </button>

        <label>
          Output
          <select
            value={selectedOutput}
            onChange={(e) => changeOutput(e.target.value)}
          >
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="test-panel">
        <h2>Developer Test Tools</h2>

        <button onClick={toggleTestMode}>
          {testMode ? "Stop Test Mode" : "Start Test Mode"}
        </button>

        {testMode && (
          <>
            <label>
              Fake Player Distance: {fakePlayerOffset} units
              <input
                type="range"
                min="0"
                max="5000"
                step="100"
                value={fakePlayerOffset}
                onChange={(e) => setFakePlayerOffset(Number(e.target.value))}
              />
            </label>

            <div>Simulated Volume: {Math.round(proximityVolume * 100)}%</div>

            <label>
              Position: {testPan}
              <input
                type="range"
                min="-100"
                max="100"
                value={testPan}
                onChange={(e) => setTestPan(Number(e.target.value))}
              />
            </label>

            <div>
              {testPan < -10 ? "Left" : testPan > 10 ? "Right" : "Center"}
            </div>
          </>
        )}
      </div>

      <button
        className="connect"
        onClick={connectVoice}
        disabled={voiceConnecting || !steamId}
      >
        {voiceConnecting
          ? "Connecting..."
          : voiceConnected
            ? "Disconnect Voice"
            : "Connect Voice"}
      </button>
    </main>
  );
}

export default App;
