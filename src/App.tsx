import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [gameRunning, setGameRunning] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const loadDevices = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
    };

    loadDevices();
  }, []);

  useEffect(() => {
    if (!selectedInput) return;

    const startMic = async () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: selectedInput },
        },
      });

      streamRef.current = stream;

      const audioContext = new AudioContext();
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
    };

    startMic();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [selectedInput]);

  useEffect(() => {
    const checkGame = async () => {
      const running = await invoke<boolean>("is_the_isle_running");
      setGameRunning(running);
    };

    checkGame();

    const interval = setInterval(checkGame, 3000);

    return () => clearInterval(interval);
  }, []);

  const changeInput = (deviceId: string) => {
    setSelectedInput(deviceId);
    localStorage.setItem("audioInput", deviceId);
  };

  const changeOutput = (deviceId: string) => {
    setSelectedOutput(deviceId);
    localStorage.setItem("audioOutput", deviceId);
  };

  const toggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);

    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
  };

  return (
    <main className="app">
      <h1>GREENLAND VOICE</h1>

      <div className="status">
        <span className="dot" />
        Disconnected
      </div>

      <div className="status">
        <span className={`dot ${gameRunning ? "online" : ""}`} />
        The Isle: {gameRunning ? "Detected" : "Not Running"}
      </div>

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
          <div className="meter-fill" style={{ width: `${micLevel}%` }} />
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

      <button className="connect">Connect</button>
    </main>
  );
}

export default App;
