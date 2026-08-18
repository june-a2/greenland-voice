import "dotenv/config";
import net from "node:net";
import { WebSocketServer } from "ws";

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = Number(process.env.RCON_PORT);
const RCON_PASSWORD = process.env.RCON_PASSWORD;

if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  throw new Error("Missing RCON configuration");
}

console.log("Greenland backend starting...");
console.log(`RCON target: ${RCON_HOST}:${RCON_PORT}`);
const wss = new WebSocketServer({ port: 8787 });

wss.on("connection", (client) => {
  console.log("Greenland Voice client connected");

  client.send(
    JSON.stringify({
      type: "players",
      players: currentPlayers,
    }),
  );
});

const socket = net.createConnection(
  {
    host: RCON_HOST,
    port: RCON_PORT,
  },
  () => {
    console.log("TCP connected to Greenland PH RCON");
    const authPacket = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from(RCON_PASSWORD),
      Buffer.from([0x00]),
    ]);

    socket.write(authPacket);
    console.log("RCON auth packet sent");
  },
);

socket.on("error", (error) => {
  console.error("RCON connection error:", error.message);
});
function parsePlayers(text: string) {
  const players = [];

  const regex =
    /Name:\s*(.*?),\s*PlayerID:\s*(\d+),\s*Gender:\s*(.*?),\s*Location:\s*X=([-\d.]+)\s*Y=([-\d.]+)\s*Z=([-\d.]+),\s*Class:\s*(.*?),\s*Growth:\s*([\d.]+).*?PrimeElder:\s*(true|false)/gs;

  let match;

  while ((match = regex.exec(text)) !== null) {
    players.push({
      name: match[1],
      steamId: match[2],
      gender: match[3],
      x: Number(match[4]),
      y: Number(match[5]),
      z: Number(match[6]),
      className: match[7],
      growth: Number(match[8]),
      primeElder: match[9] === "true",
    });
  }

  return players;
}

function distance3D(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

let currentPlayers: ReturnType<typeof parsePlayers> = [];

socket.on("data", (data) => {
  const response = data.toString();
  const players = parsePlayers(response);

  if (players.length > 0) {
    currentPlayers = players;

    const message = JSON.stringify({
      type: "players",
      players: currentPlayers,
    });

    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }

    for (const player of currentPlayers) {
      console.log(
        `${player.name} | ${player.className} | X:${player.x} Y:${player.y} Z:${player.z}`,
      );
    }
  }

  console.log("RCON response:", response);

  if (response.includes("Password Accepted")) {
    const sendPlayerDataRequest = () => {
      const commandPacket = Buffer.from([0x02, 0x77, 0x00]);
      socket.write(commandPacket);
    };

    sendPlayerDataRequest();

    setInterval(sendPlayerDataRequest, 1000);
  }
});
