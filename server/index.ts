import "dotenv/config";
import net from "node:net";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AccessToken } from "livekit-server-sdk";

const RCON_HOST = process.env.RCON_HOST;
const RCON_PORT = Number(process.env.RCON_PORT);
const RCON_PASSWORD = process.env.RCON_PASSWORD;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const PORT = Number(process.env.PORT) || 8787;

if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  throw new Error("Missing RCON configuration");
}

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LiveKit configuration");
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

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
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

  if (req.url?.startsWith("/livekit-token")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      const steamId = url.searchParams.get("steamId");

      if (!steamId) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "Missing steamId",
          }),
        );

        return;
      }

      const player = currentPlayers.find(
        (player) => player.steamId === steamId,
      );

      if (!player) {
        res.writeHead(403, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "Player is not currently on the server",
          }),
        );

        return;
      }

      const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: steamId,
        name: player.name,
      });

      token.addGrant({
        roomJoin: true,
        room: "greenland-voice",
        canPublish: true,
        canSubscribe: true,
      });

      const participantToken = await token.toJwt();

      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          serverUrl: LIVEKIT_URL,
          token: participantToken,
        }),
      );

      return;
    } catch (error) {
      console.error("LiveKit token error:", error);

      res.writeHead(500, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "Unable to create LiveKit token",
        }),
      );

      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/plain",
  });

  res.end("Greenland Voice Backend");
});

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
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
