import { useEffect, useState } from "react";
import "./App.css";

type Device = {
  deviceId: string;
  label: string;
};

function App() {
  const [inputs, setInputs] = useState<Device[]>([]);
  const [outputs, setOutputs] = useState<Device[]>([]);

  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });

        const devices = await navigator.mediaDevices.enumerateDevices();

        setInputs(
          devices
            .filter((device) => device.kind === "audioinput")
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || "Microphone",
            })),
        );

        setOutputs(
          devices
            .filter((device) => device.kind === "audiooutput")
            .map((device) => ({
              deviceId: device.deviceId,
              label: device.label || "Output Device",
            })),
        );
      } catch (error) {
        console.error("Unable to load audio devices:", error);
      }
    };

    loadDevices();
  }, []);

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
          <select>
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Output
          <select>
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
