import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlackPayload,
  isValidDestination,
  normalizeDestination,
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
