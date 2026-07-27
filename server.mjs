import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3847;
const MAX_BODY_BYTES = 64 * 1024;
const SEND_COOLDOWN_MS = 3_000;
const INDEX_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));

export function normalizeDestination(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidDestination(value) {
  return /^[CGDU][A-Z0-9]{8,20}$/.test(normalizeDestination(value));
}

export function buildSlackPayload(destination, text) {
  return {
    channel: normalizeDestination(destination),
    text: String(text ?? "").trim(),
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
}

function respondJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error("Request is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isAllowedOrigin(request, host, port) {
  const origin = request.headers.origin;
  return (
    !origin ||
    origin === `http://${host}:${port}` ||
    origin === `http://localhost:${port}`
  );
}

export function createControllerServer({
  token,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  fetchImpl = fetch,
} = {}) {
  let lastSendAt = 0;

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "GET" && url.pathname === "/") {
      const html = await readFile(INDEX_PATH);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(html);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      respondJson(response, 200, { ready: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/send") {
      if (!isAllowedOrigin(request, host, port)) {
        respondJson(response, 403, { ok: false, error: "Blocked request origin." });
        return;
      }

      const now = Date.now();
      if (now - lastSendAt < SEND_COOLDOWN_MS) {
        respondJson(response, 429, {
          ok: false,
          error: "Please wait three seconds before sending again.",
        });
        return;
      }

      try {
        const body = await readJson(request);
        const payload = buildSlackPayload(body.destination, body.text);

        if (!isValidDestination(payload.channel)) {
          respondJson(response, 400, {
            ok: false,
            error:
              "Enter a valid Slack channel, conversation, or member ID beginning with C, G, D, or U.",
          });
          return;
        }
        if (!payload.text || payload.text.length > 12_000) {
          respondJson(response, 400, {
            ok: false,
            error: "The message must contain between 1 and 12,000 characters.",
          });
          return;
        }

        lastSendAt = now;
        const slackResponse = await fetchImpl(
          "https://slack.com/api/chat.postMessage",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify(payload),
          },
        );
        const result = await slackResponse.json();

        if (!result.ok) {
          respondJson(response, 502, {
            ok: false,
            error: `Slack rejected the message: ${result.error ?? "unknown_error"}`,
          });
          return;
        }

        respondJson(response, 200, {
          ok: true,
          channel: result.channel,
          timestamp: result.ts,
        });
      } catch (error) {
        respondJson(response, 500, {
          ok: false,
          error:
            error instanceof Error ? error.message : "Unable to send the message.",
        });
      }
      return;
    }

    respondJson(response, 404, { ok: false, error: "Not found." });
  });
}

export function startController() {
  const token = process.env.SLACK_BOT_TOKEN ?? "";
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  if (!token.startsWith("xoxb-")) {
    console.error(
      "SLACK_BOT_TOKEN must contain a Slack bot token beginning with xoxb-.",
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
    return;
  }

  const server = createControllerServer({ token, host, port });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use.`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Slack Message Controller: http://${host}:${port}`);
    console.log("Press Control-C to stop.");
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  startController();
}
