import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  buildMessageBlocks,
  buildSlackPayload,
  createControllerServer,
  isDeleteAuthorized,
  isValidDestination,
  normalizeDestination,
  parseAllowedUserIds,
  parseSlackInteraction,
  verifySlackSignature,
} from "../server.mjs";

test("normalizes Slack destinations", () => {
  assert.equal(normalizeDestination(" c012abcDEF "), "C012ABCDEF");
});

test("accepts supported Slack destination types", () => {
  for (const value of [
    "C012ABCDEF",
    "G012ABCDEF",
    "D012ABCDEF",
    "U012ABCDEF",
  ]) {
    assert.equal(isValidDestination(value), true, value);
  }
});

test("rejects names, malformed IDs, and secrets", () => {
  for (const value of ["general", "Rose", "xoxb-not-an-id", "", "C123"]) {
    assert.equal(isValidDestination(value), false, value);
  }
});

test("builds a safe Slack payload", () => {
  assert.deepEqual(buildSlackPayload(" c012abcdef ", " Hello "), {
    channel: "C012ABCDEF",
    text: "Hello",
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("adds a confirmed danger-style Delete button only when enabled", () => {
  const payload = buildSlackPayload("C012ABCDEF", "Hello", {
    deleteButtonEnabled: true,
  });
  const blocks = buildMessageBlocks("Hello");
  const button = blocks.at(-1).elements[0];

  assert.deepEqual(payload.blocks, blocks);
  assert.equal(button.action_id, "delete_trinity_message");
  assert.equal(button.style, "danger");
  assert.equal(button.confirm.style, "danger");
});

test("splits long Slack text into valid section blocks", () => {
  const blocks = buildMessageBlocks("x".repeat(6_001));
  const sections = blocks.filter((block) => block.type === "section");

  assert.deepEqual(
    sections.map((section) => section.text.text.length),
    [3_000, 3_000, 1],
  );
});

test("normalizes the delete allowlist and authorizes only listed members", () => {
  const allowed = parseAllowedUserIds(
    " U012ABCDEF,invalid,U999ZZZZZZZ,U012ABCDEF ",
  );

  assert.deepEqual([...allowed], ["U012ABCDEF", "U999ZZZZZZZ"]);
  assert.equal(isDeleteAuthorized("u012abcdef", allowed), true);
  assert.equal(isDeleteAuthorized("U111AAAAAAA", allowed), false);
});

test("verifies Slack signatures and rejects tampered or stale requests", () => {
  const signingSecret = "test-signing-secret";
  const timestamp = "1_800_000_000".replaceAll("_", "");
  const rawBody = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const now = Number(timestamp) * 1_000;

  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody,
      now,
    }),
    true,
  );
  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody: `${rawBody}tampered`,
      now,
    }),
    false,
  );
  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp,
      signature,
      rawBody,
      now: now + 301_000,
    }),
    false,
  );
});

test("parses Slack form-encoded interaction payloads", () => {
  const interaction = {
    type: "block_actions",
    user: { id: "U012ABCDEF" },
  };
  const rawBody = new URLSearchParams({
    payload: JSON.stringify(interaction),
  }).toString();

  assert.deepEqual(parseSlackInteraction(rawBody), interaction);
});

test("deletes an app message after an authorized signed button click", async (context) => {
  const signingSecret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const interaction = {
    type: "block_actions",
    user: { id: "U012ABCDEF" },
    channel: { id: "C012ABCDEF" },
    message: { ts: "1800000000.123456" },
    actions: [{ action_id: "delete_trinity_message" }],
  };
  const rawBody = new URLSearchParams({
    payload: JSON.stringify(interaction),
  }).toString();
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const slackRequests = [];
  const fetchImpl = async (url, options) => {
    slackRequests.push({ url, options });
    return {
      json: async () => ({
        ok: true,
        channel: "C012ABCDEF",
        ts: "1800000000.123456",
      }),
    };
  };
  const server = createControllerServer({
    token: "xoxb-test-token",
    signingSecret,
    deleteAllowedUserIds: "U012ABCDEF",
    host: "127.0.0.1",
    port: 0,
    fetchImpl,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/slack/interactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signature,
      },
      body: rawBody,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.status, 200);
  assert.equal(slackRequests.length, 1);
  assert.equal(slackRequests[0].url, "https://slack.com/api/chat.delete");
  assert.deepEqual(JSON.parse(slackRequests[0].options.body), {
    channel: "C012ABCDEF",
    ts: "1800000000.123456",
  });
});
