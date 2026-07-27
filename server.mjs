import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3847;
const DEFAULT_INTERACTIONS_PORT = 3848;
const MAX_BODY_BYTES = 64 * 1024;
const SEND_COOLDOWN_MS = 3_000;
const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const SLACK_SECTION_TEXT_LIMIT = 3_000;
const DELETE_ACTION_ID = "delete_trinity_message";
const INDEX_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));

export function normalizeDestination(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function isValidDestination(value) {
  return /^[CGDU][A-Z0-9]{8,20}$/.test(normalizeDestination(value));
}

export function parseAllowedUserIds(value) {
  const values =
    value instanceof Set
      ? [...value]
      : Array.isArray(value)
        ? value
        : String(value ?? "").split(",");
  return new Set(
    values
      .map(normalizeDestination)
      .filter((item) => /^U[A-Z0-9]{8,20}$/.test(item)),
  );
}

export function isDeleteAuthorized(userId, allowedUserIds) {
  return parseAllowedUserIds(allowedUserIds).has(normalizeDestination(userId));
}

function splitSlackText(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += SLACK_SECTION_TEXT_LIMIT) {
    chunks.push(text.slice(offset, offset + SLACK_SECTION_TEXT_LIMIT));
  }
  return chunks;
}

export function buildMessageBlocks(text) {
  return [
    ...splitSlackText(text).map((chunk) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: chunk,
      },
    })),
    {
      type: "actions",
      block_id: "trinity_message_controls",
      elements: [
        {
          type: "button",
          action_id: DELETE_ACTION_ID,
          text: {
            type: "plain_text",
            text: "Delete",
            emoji: true,
          },
          style: "danger",
          value: "delete",
          confirm: {
            title: {
              type: "plain_text",
              text: "Delete this message?",
            },
            text: {
              type: "mrkdwn",
              text: "This permanently deletes the Trinity message.",
            },
            confirm: {
              type: "plain_text",
              text: "Delete",
            },
            deny: {
              type: "plain_text",
              text: "Cancel",
            },
            style: "danger",
          },
        },
      ],
    },
  ];
}

export function buildSlackPayload(
  destination,
  text,
  { deleteButtonEnabled = false } = {},
) {
  const payload = {
    channel: normalizeDestination(destination),
    text: String(text ?? "").trim(),
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };

  if (deleteButtonEnabled && payload.text) {
    payload.blocks = buildMessageBlocks(payload.text);
  }
  return payload;
}

export function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  now = Date.now(),
}) {
  const timestampNumber = Number(timestamp);
  if (
    !signingSecret ||
    !signature ||
    !Number.isFinite(timestampNumber) ||
    Math.abs(Math.floor(now / 1_000) - timestampNumber) >
      SLACK_SIGNATURE_MAX_AGE_SECONDS
  ) {
    return false;
  }

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function parseSlackInteraction(rawBody) {
  const encodedPayload = new URLSearchParams(rawBody).get("payload");
  if (!encodedPayload) {
    throw new Error("Slack interaction payload is missing.");
  }
  return JSON.parse(encodedPayload);
}

function respondJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let rejected = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error("Request is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!rejected) resolve(raw);
    });
    request.on("error", reject);
  });
}

async function readJson(request) {
  try {
    return JSON.parse(await readRawBody(request));
  } catch {
    throw new Error("Invalid JSON.");
  }
}

function isAllowedOrigin(request, host, port) {
  const origin = request.headers.origin;
  return (
    !origin ||
    origin === `http://${host}:${port}` ||
    origin === `http://localhost:${port}`
  );
}

async function sendInteractionFeedback(responseUrl, text, fetchImpl) {
  if (!responseUrl?.startsWith("https://hooks.slack.com/")) return;

  await fetchImpl(responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text,
    }),
  });
}

async function deleteSlackMessage({ token, channel, timestamp, fetchImpl }) {
  const response = await fetchImpl("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      ts: timestamp,
    }),
  });
  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.error ?? "unknown_error");
  }
  return result;
}

function createInteractionHandler({
  token,
  signingSecret,
  allowedDeleteUsers,
  fetchImpl,
}) {
  return async (request, response) => {
    try {
      const rawBody = await readRawBody(request);
      const timestamp = request.headers["x-slack-request-timestamp"];
      const signature = request.headers["x-slack-signature"];

      if (
        !verifySlackSignature({
          signingSecret,
          timestamp,
          signature,
          rawBody,
        })
      ) {
        respondJson(response, 401, {
          ok: false,
          error: "Invalid Slack signature.",
        });
        return;
      }

      const interaction = parseSlackInteraction(rawBody);
      const action = interaction.actions?.[0];
      const userId = interaction.user?.id;
      const channel = interaction.channel?.id;
      const messageTimestamp = interaction.message?.ts;

      if (
        interaction.type !== "block_actions" ||
        action?.action_id !== DELETE_ACTION_ID
      ) {
        response.writeHead(200);
        response.end();
        return;
      }

      response.writeHead(200);
      response.end();

      if (!isDeleteAuthorized(userId, allowedDeleteUsers)) {
        void sendInteractionFeedback(
          interaction.response_url,
          "You are not authorized to delete Trinity messages.",
          fetchImpl,
        ).catch(() => {});
        return;
      }

      if (
        !isValidDestination(channel) ||
        !/^\d+\.\d+$/.test(messageTimestamp ?? "")
      ) {
        void sendInteractionFeedback(
          interaction.response_url,
          "Trinity could not identify the message to delete.",
          fetchImpl,
        ).catch(() => {});
        return;
      }

      void deleteSlackMessage({
        token,
        channel,
        timestamp: messageTimestamp,
        fetchImpl,
      }).catch((error) => {
        void sendInteractionFeedback(
          interaction.response_url,
          `Trinity could not delete the message: ${error.message}`,
          fetchImpl,
        ).catch(() => {});
      });
    } catch {
      respondJson(response, 400, {
        ok: false,
        error: "Invalid Slack interaction payload.",
      });
    }
  };
}

export function createInteractionServer({
  token,
  signingSecret,
  deleteAllowedUserIds,
  fetchImpl = fetch,
} = {}) {
  const allowedDeleteUsers = parseAllowedUserIds(deleteAllowedUserIds);
  const handleInteraction = createInteractionHandler({
    token,
    signingSecret,
    allowedDeleteUsers,
    fetchImpl,
  });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/health") {
      respondJson(response, 200, { ready: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      await handleInteraction(request, response);
      return;
    }

    respondJson(response, 404, { ok: false, error: "Not found." });
  });
}

export function createControllerServer({
  token,
  signingSecret = "",
  deleteAllowedUserIds = [],
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  fetchImpl = fetch,
} = {}) {
  let lastSendAt = 0;
  const allowedDeleteUsers = parseAllowedUserIds(deleteAllowedUserIds);
  const deleteButtonEnabled = Boolean(signingSecret && allowedDeleteUsers.size);

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
      respondJson(response, 200, {
        ready: true,
        deleteButtonEnabled,
      });
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
        const payload = buildSlackPayload(body.destination, body.text, {
          deleteButtonEnabled,
        });

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
          deleteButtonIncluded: deleteButtonEnabled,
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
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const deleteAllowedUserIds =
    process.env.SLACK_DELETE_ALLOWED_USER_IDS ?? "";
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const interactionsPort = Number(
    process.env.INTERACTIONS_PORT ?? DEFAULT_INTERACTIONS_PORT,
  );

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
  if (
    !Number.isInteger(interactionsPort) ||
    interactionsPort < 1 ||
    interactionsPort > 65_535 ||
    interactionsPort === port
  ) {
    console.error(
      "INTERACTIONS_PORT must be a different integer between 1 and 65535.",
    );
    process.exitCode = 1;
    return;
  }

  const server = createControllerServer({
    token,
    signingSecret,
    deleteAllowedUserIds,
    host,
    port,
  });
  const handleServerError = (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`A required local port is already in use.`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  };
  server.on("error", handleServerError);
  server.listen(port, host, () => {
    console.log(`Slack Message Controller: http://${host}:${port}`);
    if (signingSecret && parseAllowedUserIds(deleteAllowedUserIds).size) {
      console.log("Delete buttons: enabled");
      console.log(
        `Signed interaction listener: http://${host}:${interactionsPort}/slack/interactions`,
      );
    } else {
      console.log(
        "Delete buttons: disabled (set SLACK_SIGNING_SECRET and SLACK_DELETE_ALLOWED_USER_IDS)",
      );
    }
    console.log("Press Control-C to stop.");
  });

  if (signingSecret && parseAllowedUserIds(deleteAllowedUserIds).size) {
    const interactionServer = createInteractionServer({
      token,
      signingSecret,
      deleteAllowedUserIds,
    });
    interactionServer.on("error", handleServerError);
    interactionServer.listen(interactionsPort, host);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  startController();
}
