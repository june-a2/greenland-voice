import { useEffect, useState } from "react";
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

  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });

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
      } catch (error) {
        console.error("Unable to load audio devices:", error);
      }
    };

    loadDevices();
  }, []);

  const changeInput = (deviceId: string) => {
    setSelectedInput(deviceId);
    localStorage.setItem("audioInput", deviceId);
  };

  const changeOutput = (deviceId: string) => {
    setSelectedOutput(deviceId);
    localStorage.setItem("audioOutput", deviceId);
  };

  return (
    <main className="app">
      <h1>GREENLAND VOICE</h1>

      <div className="status">
        <span className="dot" />
        Disconnected
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
