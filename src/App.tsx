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
  const [testPan, setTestPan] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);

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

  const maxDistance = 50;

  const normalizedDistance = Math.min(testDistance / maxDistance, 1);

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
              Distance: {testDistance}m
              <input
                type="range"
                min="0"
                max={maxDistance}
                value={testDistance}
                onChange={(e) => setTestDistance(Number(e.target.value))}
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

      <button className="connect">Connect</button>
    </main>
  );
}

export default App;
