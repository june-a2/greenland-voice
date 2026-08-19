import "dotenv/config";
import crypto from "node:crypto";
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

const PUBLIC_URL =
  process.env.PUBLIC_URL || "https://greenland-voice.onrender.com";

const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";

const VOICE_RADIUS = 5000;

if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  throw new Error("Missing RCON configuration");
}

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LiveKit configuration");
}

type Player = {
  name: string;
  steamId: string;
  gender: string;
  x: number;
  y: number;
  z: number;
  className: string;
  growth: number;
  primeElder: boolean;
};

type AuthRequest = {
  expectedSteamId: string;
  createdAt: number;
  verifiedSteamId?: string;
};

type Session = {
  steamId: string;
  createdAt: number;
  expiresAt: number;
};

type AuthenticatedClient = {
  socket: WebSocket;
  steamId: string;
};

const authRequests = new Map<string, AuthRequest>();

const sessions = new Map<string, Session>();

const authenticatedClients = new Map<WebSocket, AuthenticatedClient>();

const AUTH_REQUEST_TTL = 5 * 60 * 1000;

const SESSION_TTL = 12 * 60 * 60 * 1000;

let currentPlayers: Player[] = [];

let rconSocket: net.Socket | null = null;
let rconPollInterval: NodeJS.Timeout | null = null;
let rconReconnectTimer: NodeJS.Timeout | null = null;

let rconBuffer = Buffer.alloc(0);
let rconAuthenticated = false;
let rconRequestPending = false;
let rconResponseSettleTimer: NodeJS.Timeout | null = null;
let rconResponseTimeout: NodeJS.Timeout | null = null;
let rconAuthTimeout: NodeJS.Timeout | null = null;
let consecutiveRconMisses = 0;
let lastPlayerUpdateAt = 0;

const RCON_POLL_MS = 1000;
const RCON_RESPONSE_SETTLE_MS = 120;
const RCON_RESPONSE_TIMEOUT_MS = 2500;
const RCON_AUTH_TIMEOUT_MS = 10_000;
const RCON_MISSES_BEFORE_CLEAR = 3;
const RCON_MAX_BUFFER_BYTES = 512 * 1024;

function createRandomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Headers": "Content-Type, Authorization",

    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });

  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
  });

  res.end(html);
}

function getBearerToken(req: http.IncomingMessage) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice(7);
}

function getSession(token: string | null | undefined): Session | null {
  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);

    return null;
  }

  return session;
}

function cleanupAuthData() {
  const now = Date.now();

  for (const [authId, request] of authRequests.entries()) {
    if (request.createdAt + AUTH_REQUEST_TTL <= now) {
      authRequests.delete(authId);
    }
  }

  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

setInterval(cleanupAuthData, 60_000);

function parsePlayers(text: string): Player[] {
  const players: Player[] = [];

  const regex =
    /Name:\s*(.*?),\s*PlayerID:\s*(\d+),\s*Gender:\s*(.*?),\s*Location:\s*X=([-\d.]+)\s*Y=([-\d.]+)\s*Z=([-\d.]+),\s*Class:\s*(.*?),\s*Growth:\s*([\d.]+).*?PrimeElder:\s*(true|false)/gs;

  let match;

  while ((match = regex.exec(text)) !== null) {
    players.push({
      name: match[1].trim(),

      steamId: match[2],

      gender: match[3].trim(),

      x: Number(match[4]),

      y: Number(match[5]),

      z: Number(match[6]),

      className: match[7].trim(),

      growth: Number(match[8]),

      primeElder: match[9] === "true",
    });
  }

  return players;
}

function calculateDistance(a: Player, b: Player) {
  const dx = a.x - b.x;

  const dy = a.y - b.y;

  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function calculateVolume(distance: number) {
  if (distance >= VOICE_RADIUS) {
    return 0;
  }

  const normalized = 1 - distance / VOICE_RADIUS;

  return Math.max(0, Math.min(1, normalized));
}

function buildSnapshot(steamId: string) {
  const self = currentPlayers.find((player) => player.steamId === steamId);

  if (!self) {
    return {
      type: "snapshot",
      self: null,
      nearby: [],
    };
  }

  const nearby = currentPlayers
    .filter((player) => player.steamId !== steamId)
    .map((player) => {
      const distance = calculateDistance(self, player);

      return {
        name: player.name,

        steamId: player.steamId,

        distance,

        volume: calculateVolume(distance),
      };
    })
    .filter((player) => player.distance < VOICE_RADIUS)
    .map(({ name, steamId, volume }) => ({
      name,
      steamId,
      volume,
    }));

  return {
    type: "snapshot",

    self: {
      x: self.x,
      y: self.y,
      z: self.z,
    },

    nearby,
  };
}

function broadcastSnapshots() {
  for (const [socket, client] of authenticatedClients.entries()) {
    if (socket.readyState !== WebSocket.OPEN) {
      authenticatedClients.delete(socket);

      continue;
    }

    const snapshot = buildSnapshot(client.steamId);

    socket.send(JSON.stringify(snapshot));
  }
}

async function verifySteamOpenId(url: URL) {
  const params = new URLSearchParams();

  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("openid.")) {
      params.set(key, value);
    }
  }

  params.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },

    body: params.toString(),
  });

  if (!response.ok) {
    return null;
  }

  const body = await response.text();

  const valid = body
    .split("\n")
    .some((line) => line.trim() === "is_valid:true");

  if (!valid) {
    return null;
  }

  const claimedId = url.searchParams.get("openid.claimed_id");

  if (!claimedId) {
    return null;
  }

  const match = claimedId.match(
    /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/,
  );

  if (!match) {
    return null;
  }

  return match[1];
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();

    return;
  }

  const requestUrl = new URL(req.url || "/", PUBLIC_URL);

  if (requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",

      players: currentPlayers.length,

      rcon: rconAuthenticated ? "connected" : "disconnected",

      playerDataAgeMs:
        lastPlayerUpdateAt > 0 ? Date.now() - lastPlayerUpdateAt : null,
    });

    return;
  }

  if (requestUrl.pathname === "/auth/steam/start") {
    const expectedSteamId = requestUrl.searchParams.get("steamId");

    if (!expectedSteamId || !/^\d{17}$/.test(expectedSteamId)) {
      sendJson(res, 400, {
        error: "Invalid SteamID",
      });

      return;
    }

    const authId = createRandomToken();

    authRequests.set(authId, {
      expectedSteamId,
      createdAt: Date.now(),
    });

    const returnUrl =
      `${PUBLIC_URL}` +
      `/auth/steam/callback` +
      `?authId=${encodeURIComponent(authId)}`;

    const openIdUrl = new URL(STEAM_OPENID_URL);

    openIdUrl.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");

    openIdUrl.searchParams.set("openid.mode", "checkid_setup");

    openIdUrl.searchParams.set("openid.return_to", returnUrl);

    openIdUrl.searchParams.set("openid.realm", `${PUBLIC_URL}/`);

    openIdUrl.searchParams.set(
      "openid.identity",
      "http://specs.openid.net/auth/2.0/identifier_select",
    );

    openIdUrl.searchParams.set(
      "openid.claimed_id",
      "http://specs.openid.net/auth/2.0/identifier_select",
    );

    sendJson(res, 200, {
      authId,
      url: openIdUrl.toString(),
    });

    return;
  }

  if (requestUrl.pathname === "/auth/steam/callback") {
    try {
      const authId = requestUrl.searchParams.get("authId");

      if (!authId) {
        sendHtml(
          res,
          400,
          `
                <!doctype html>
                <html>
                  <body style="
                    margin:0;
                    min-height:100vh;
                    display:grid;
                    place-items:center;
                    background:#111111;
                    color:#ffffff;
                    font-family:Arial,sans-serif;
                  ">
                    <div>
                      <h2>
                        Invalid verification request
                      </h2>
                      <p>
                        Return to Greenland Voice
                        and try again.
                      </p>
                    </div>
                  </body>
                </html>
              `,
        );

        return;
      }

      const authRequest = authRequests.get(authId);

      if (!authRequest) {
        sendHtml(
          res,
          400,
          `
                <!doctype html>
                <html>
                  <body style="
                    margin:0;
                    min-height:100vh;
                    display:grid;
                    place-items:center;
                    background:#111111;
                    color:#ffffff;
                    font-family:Arial,sans-serif;
                  ">
                    <div>
                      <h2>
                        Verification expired
                      </h2>
                      <p>
                        Return to Greenland Voice
                        and try again.
                      </p>
                    </div>
                  </body>
                </html>
              `,
        );

        return;
      }

      const verifiedSteamId = await verifySteamOpenId(requestUrl);

      if (!verifiedSteamId) {
        sendHtml(
          res,
          401,
          `
                <!doctype html>
                <html>
                  <body style="
                    margin:0;
                    min-height:100vh;
                    display:grid;
                    place-items:center;
                    background:#111111;
                    color:#ffffff;
                    font-family:Arial,sans-serif;
                  ">
                    <div>
                      <h2>
                        Steam verification failed
                      </h2>
                      <p>
                        Return to Greenland Voice
                        and try again.
                      </p>
                    </div>
                  </body>
                </html>
              `,
        );

        return;
      }

      if (verifiedSteamId !== authRequest.expectedSteamId) {
        sendHtml(
          res,
          403,
          `
                <!doctype html>
                <html>
                  <body style="
                    margin:0;
                    min-height:100vh;
                    display:grid;
                    place-items:center;
                    background:#111111;
                    color:#ffffff;
                    font-family:Arial,sans-serif;
                  ">
                    <div style="
                      max-width:440px;
                      padding:30px;
                      text-align:center;
                    ">
                      <h2>
                        Wrong Steam account
                      </h2>

                      <p style="
                        color:#a5a5a5;
                        line-height:1.6;
                      ">
                        The account verified in
                        Steam does not match the
                        Steam account detected by
                        Greenland Voice.
                      </p>
                    </div>
                  </body>
                </html>
              `,
        );

        return;
      }

      authRequest.verifiedSteamId = verifiedSteamId;

      authRequests.set(authId, authRequest);

      sendHtml(
        res,
        200,
        `
              <!doctype html>

              <html>
                <head>
                  <title>
                    Greenland Voice
                  </title>

                  <meta
                    name="viewport"
                    content="
                      width=device-width,
                      initial-scale=1
                    "
                  />
                </head>

                <body style="
                  margin:0;
                  min-height:100vh;
                  display:grid;
                  place-items:center;
                  background:#111111;
                  color:#ffffff;
                  font-family:Arial,sans-serif;
                ">
                  <div style="
                    max-width:420px;
                    padding:32px;
                    text-align:center;
                  ">
                    <div style="
                      color:#92c553;
                      font-size:40px;
                      margin-bottom:14px;
                    ">
                      ✓
                    </div>

                    <h2>
                      Steam verified
                    </h2>

                    <p style="
                      color:#a0a4a0;
                      line-height:1.6;
                    ">
                      You can close this window
                      and return to Greenland Voice.
                    </p>
                  </div>
                </body>
              </html>
            `,
      );

      return;
    } catch (error) {
      console.error("Steam callback error:", error);

      sendHtml(
        res,
        500,
        `
              <h2>
                Unable to verify Steam
              </h2>
            `,
      );

      return;
    }
  }

  if (requestUrl.pathname === "/auth/steam/status") {
    const authId = requestUrl.searchParams.get("authId");

    if (!authId) {
      sendJson(res, 400, {
        error: "Missing authId",
      });

      return;
    }

    const authRequest = authRequests.get(authId);

    if (!authRequest) {
      sendJson(res, 404, {
        status: "expired",
      });

      return;
    }

    if (!authRequest.verifiedSteamId) {
      sendJson(res, 200, {
        status: "pending",
      });

      return;
    }

    const token = createRandomToken();

    sessions.set(token, {
      steamId: authRequest.verifiedSteamId,

      createdAt: Date.now(),

      expiresAt: Date.now() + SESSION_TTL,
    });

    authRequests.delete(authId);

    sendJson(res, 200, {
      status: "verified",

      token,

      steamId: authRequest.verifiedSteamId,
    });

    return;
  }

  if (requestUrl.pathname === "/auth/me") {
    const token = getBearerToken(req);

    const session = getSession(token);

    if (!session) {
      sendJson(res, 401, {
        authenticated: false,
      });

      return;
    }

    sendJson(res, 200, {
      authenticated: true,

      steamId: session.steamId,
    });

    return;
  }

  if (requestUrl.pathname === "/auth/logout") {
    const token = getBearerToken(req);

    if (token) {
      sessions.delete(token);
    }

    sendJson(res, 200, {
      ok: true,
    });

    return;
  }

  if (requestUrl.pathname === "/livekit-token") {
    try {
      const token = getBearerToken(req);

      const session = getSession(token);

      if (!session) {
        sendJson(res, 401, {
          error: "Authentication required",
        });

        return;
      }

      const player = currentPlayers.find(
        (player) => player.steamId === session.steamId,
      );

      if (!player) {
        sendJson(res, 403, {
          error: "Verified Steam user is not currently on Greenland PH",
        });

        return;
      }

      const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: session.steamId,

        name: player.name,

        ttl: "1h",
      });

      accessToken.addGrant({
        roomJoin: true,

        room: "greenland-voice",

        canPublish: true,
        canSubscribe: true,
      });

      const participantToken = await accessToken.toJwt();

      sendJson(res, 200, {
        serverUrl: LIVEKIT_URL,

        token: participantToken,
      });

      return;
    } catch (error) {
      console.error("LiveKit token error:", error);

      sendJson(res, 500, {
        error: "Unable to create LiveKit token",
      });

      return;
    }
  }

  sendJson(res, 404, {
    error: "Not found",
  });
});

const wss = new WebSocketServer({
  server: httpServer,

  path: "/ws",
});

wss.on("connection", (socket) => {
  let authenticated = false;

  const authTimeout = setTimeout(() => {
    if (!authenticated && socket.readyState === WebSocket.OPEN) {
      socket.close(4001, "Authentication required");
    }
  }, 5000);

  socket.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type !== "auth") {
        return;
      }

      const session = getSession(data.token);

      if (!session) {
        socket.close(4001, "Invalid session");

        return;
      }

      authenticated = true;

      clearTimeout(authTimeout);

      authenticatedClients.set(socket, {
        socket,
        steamId: session.steamId,
      });

      socket.send(
        JSON.stringify({
          type: "authenticated",

          steamId: session.steamId,
        }),
      );

      socket.send(JSON.stringify(buildSnapshot(session.steamId)));
    } catch (error) {
      console.error("WebSocket auth error:", error);
    }
  });

  socket.on("close", () => {
    clearTimeout(authTimeout);

    authenticatedClients.delete(socket);
  });

  socket.on("error", () => {
    authenticatedClients.delete(socket);
  });
});

function clearRconTimer(timer: NodeJS.Timeout | null) {
  if (timer) {
    clearTimeout(timer);
  }
}

function stopRconPoll() {
  if (rconPollInterval) {
    clearInterval(rconPollInterval);

    rconPollInterval = null;
  }

  clearRconTimer(rconResponseSettleTimer);
  clearRconTimer(rconResponseTimeout);
  clearRconTimer(rconAuthTimeout);

  rconResponseSettleTimer = null;
  rconResponseTimeout = null;
  rconAuthTimeout = null;

  rconRequestPending = false;
}

function clearPlayers(reason: string) {
  const hadPlayers = currentPlayers.length > 0;

  currentPlayers = [];
  lastPlayerUpdateAt = Date.now();

  if (hadPlayers) {
    console.warn(`Cleared tracked players: ${reason}`);
  }

  broadcastSnapshots();
}

function recordRconMiss(reason: string) {
  consecutiveRconMisses += 1;

  console.warn(
    `RCON player poll miss ${consecutiveRconMisses}/${RCON_MISSES_BEFORE_CLEAR}: ${reason}`,
  );

  if (consecutiveRconMisses >= RCON_MISSES_BEFORE_CLEAR) {
    clearPlayers(`RCON player data unavailable (${reason})`);
  }
}

function acceptPlayerSnapshot(players: Player[]) {
  const previousCount = currentPlayers.length;

  currentPlayers = players;
  lastPlayerUpdateAt = Date.now();
  consecutiveRconMisses = 0;

  if (previousCount !== players.length) {
    console.log(
      `RCON player count changed: ${previousCount} -> ${players.length}`,
    );
  }

  broadcastSnapshots();
}

function scheduleRconReconnect() {
  if (rconReconnectTimer) {
    return;
  }

  rconReconnectTimer = setTimeout(() => {
    rconReconnectTimer = null;

    connectRcon();
  }, 5000);
}

function finishPlayerRequest() {
  rconRequestPending = false;

  clearRconTimer(rconResponseSettleTimer);
  clearRconTimer(rconResponseTimeout);

  rconResponseSettleTimer = null;
  rconResponseTimeout = null;
}

function processPlayerResponse() {
  if (!rconRequestPending) {
    return;
  }

  const text = rconBuffer.toString("utf8").trim();

  rconBuffer = Buffer.alloc(0);

  finishPlayerRequest();

  if (!text) {
    recordRconMiss("empty response");

    return;
  }

  const players = parsePlayers(text);

  if (players.length > 0) {
    acceptPlayerSnapshot(players);

    return;
  }

  const lower = text.toLowerCase();

  const explicitEmptyResponse =
    lower.includes("no players") ||
    lower.includes("0 players") ||
    lower.includes("player count: 0");

  if (explicitEmptyResponse) {
    acceptPlayerSnapshot([]);

    return;
  }

  /*
   * The Isle can return a non-player payload when no usable player rows
   * are present. Do not immediately trust one unrecognized response as
   * "zero players"; require several consecutive misses before clearing
   * the previous snapshot. This prevents one fragmented or malformed
   * packet from instantly dropping everyone's tracking.
   */
  recordRconMiss("response contained no parseable player rows");
}

function schedulePlayerResponseSettle() {
  clearRconTimer(rconResponseSettleTimer);

  rconResponseSettleTimer = setTimeout(() => {
    processPlayerResponse();
  }, RCON_RESPONSE_SETTLE_MS);
}

function sendPlayerDataRequest() {
  if (
    !rconSocket ||
    !rconAuthenticated ||
    rconSocket.destroyed ||
    rconRequestPending
  ) {
    return;
  }

  rconRequestPending = true;
  rconBuffer = Buffer.alloc(0);

  const commandPacket = Buffer.from([0x02, 0x77, 0x00]);

  rconSocket.write(commandPacket);

  clearRconTimer(rconResponseTimeout);

  rconResponseTimeout = setTimeout(() => {
    if (!rconRequestPending) {
      return;
    }

    rconBuffer = Buffer.alloc(0);

    finishPlayerRequest();

    recordRconMiss("response timeout");
  }, RCON_RESPONSE_TIMEOUT_MS);
}

function handleRconAuthResponse(text: string) {
  if (!text.includes("Password Accepted")) {
    return false;
  }

  if (!rconAuthenticated) {
    console.log("RCON authenticated");
  }

  clearRconTimer(rconAuthTimeout);
  rconAuthTimeout = null;

  rconAuthenticated = true;
  consecutiveRconMisses = 0;
  rconBuffer = Buffer.alloc(0);

  if (!rconPollInterval) {
    sendPlayerDataRequest();

    rconPollInterval = setInterval(sendPlayerDataRequest, RCON_POLL_MS);
  }

  return true;
}

function connectRcon() {
  stopRconPoll();

  rconAuthenticated = false;
  rconRequestPending = false;
  consecutiveRconMisses = 0;
  rconBuffer = Buffer.alloc(0);

  if (rconReconnectTimer) {
    clearTimeout(rconReconnectTimer);
    rconReconnectTimer = null;
  }

  if (rconSocket && !rconSocket.destroyed) {
    rconSocket.destroy();
  }

  console.log(`Connecting to RCON ${RCON_HOST}:${RCON_PORT}`);

  const socket = net.createConnection({
    host: RCON_HOST,

    port: RCON_PORT,
  });

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10_000);

  rconSocket = socket;

  socket.on("connect", () => {
    console.log("TCP connected to Greenland PH RCON");

    const authPacket = Buffer.concat([
      Buffer.from([0x01]),

      Buffer.from(RCON_PASSWORD),

      Buffer.from([0x00]),
    ]);

    socket.write(authPacket);

    clearRconTimer(rconAuthTimeout);

    rconAuthTimeout = setTimeout(() => {
      if (rconAuthenticated || socket.destroyed) {
        return;
      }

      console.error("RCON authentication timed out");

      socket.destroy();
    }, RCON_AUTH_TIMEOUT_MS);
  });

  socket.on("data", (data) => {
    rconBuffer = Buffer.concat([rconBuffer, data]);

    if (rconBuffer.length > RCON_MAX_BUFFER_BYTES) {
      console.warn("RCON buffer exceeded safe size");

      rconBuffer = Buffer.alloc(0);

      if (rconRequestPending) {
        finishPlayerRequest();

        recordRconMiss("buffer exceeded safe size");
      }

      return;
    }

    const text = rconBuffer.toString("utf8");

    if (!rconAuthenticated) {
      handleRconAuthResponse(text);

      return;
    }

    if (rconRequestPending) {
      /*
       * TCP does not preserve message boundaries. A getplayerdata response
       * can arrive in more than one chunk, so wait briefly after the most
       * recent chunk before parsing the accumulated response.
       */
      schedulePlayerResponseSettle();
    }
  });

  socket.on("error", (error) => {
    console.error("RCON error:", error.message);
  });

  socket.on("close", () => {
    console.warn("RCON disconnected");

    const wasCurrentSocket = rconSocket === socket;

    rconAuthenticated = false;

    stopRconPoll();

    if (wasCurrentSocket) {
      rconSocket = null;
    }

    clearPlayers("RCON disconnected");

    scheduleRconReconnect();
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Greenland backend listening on port ${PORT}`);

  console.log(`Public URL: ${PUBLIC_URL}`);

  connectRcon();
});
