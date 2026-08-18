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
  const [gamePid, setGamePid] = useState<number | null>(null);

  const [testMode, setTestMode] = useState(false);
  const [testDistance, setTestDistance] = useState(10);

  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);

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

    if (testAudioRef.current && "setSinkId" in testAudioRef.current) {
      testAudioRef.current.setSinkId(deviceId).catch((error) => {
        console.error("Unable to change output device:", error);
      });
    }
  };

  const toggleMute = () => {
    const nextMuted = !muted;

    setMuted(nextMuted);

    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
  };

  const proximityVolume = Math.max(0, 1 - testDistance / 50);

  const toggleTestMode = async () => {
    if (!testMode) {
      if (!streamRef.current) return;

      const audio = new Audio();
      audio.srcObject = streamRef.current;
      audio.volume = proximityVolume;

      if ("setSinkId" in audio && selectedOutput) {
        try {
          await audio.setSinkId(selectedOutput);
        } catch (error) {
          console.error("Unable to set test output device:", error);
        }
      }

      try {
        await audio.play();
        testAudioRef.current = audio;
        setTestMode(true);
      } catch (error) {
        console.error("Unable to start test audio:", error);
      }
    } else {
      testAudioRef.current?.pause();
      testAudioRef.current = null;
      setTestMode(false);
    }
  };

  useEffect(() => {
    if (testAudioRef.current) {
      testAudioRef.current.volume = proximityVolume;
    }
  }, [proximityVolume]);

  useEffect(() => {
    return () => {
      testAudioRef.current?.pause();
      testAudioRef.current = null;
    };
  }, []);

  return (
    <main className="app">
      <h1>GREENLAND VOICE</h1>

      <div className="status">
        <span className="dot" />
        Disconnected
      </div>

      <div className="status">
        <span className={`dot ${gamePid ? "online" : ""}`} />
        The Isle: {gamePid ? `Detected (${gamePid})` : "Not Running"}
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

      <div className="panel">
        <button onClick={toggleTestMode}>
          {testMode ? "Stop Test Mode" : "Start Test Mode"}
        </button>

        {testMode && (
          <>
            <label>
              Test Player Distance: {testDistance}m
              <input
                type="range"
                min="0"
                max="50"
                value={testDistance}
                onChange={(e) => setTestDistance(Number(e.target.value))}
              />
            </label>

            <div>Simulated Volume: {Math.round(proximityVolume * 100)}%</div>
          </>
        )}
      </div>

      <button className="connect">Connect</button>
    </main>
  );
}

export default App;
