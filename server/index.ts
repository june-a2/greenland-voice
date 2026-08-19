import "dotenv/config";
import net from "node:net";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = Number(process.env.RCON_PORT);
const RCON_PASSWORD = process.env.RCON_PASSWORD;
const PORT = Number(process.env.PORT) || 8787;

if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  throw new Error("Missing RCON configuration");
}

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

let currentPlayers: ReturnType<typeof parsePlayers> = [];

console.log("Greenland backend starting...");
console.log(`RCON target: ${RCON_HOST}:${RCON_PORT}`);

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "ok",
        players: currentPlayers.length,
      }),
    );

    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
  });

  res.end("Greenland Voice Backend");
});

const wss = new WebSocketServer({
  server: httpServer,
});

wss.on("connection", (client) => {
  console.log("Greenland Voice client connected");

  client.send(
    JSON.stringify({
      type: "players",
      players: currentPlayers,
    }),
  );

  client.on("close", () => {
    console.log("Greenland Voice client disconnected");
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Greenland backend listening on port ${PORT}`);
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
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }

    for (const player of currentPlayers) {
      console.log(
        `${player.name} | ${player.className} | X:${player.x} Y:${player.y} Z:${player.z}`,
      );
    }
  }

  if (response.includes("Password Accepted")) {
    console.log("RCON authenticated");

    const sendPlayerDataRequest = () => {
      const commandPacket = Buffer.from([0x02, 0x77, 0x00]);

      socket.write(commandPacket);
    };

    sendPlayerDataRequest();

    setInterval(sendPlayerDataRequest, 1000);
  }
});
