import test from "node:test";
import assert from "node:assert/strict";
import {
  createRunControlAck,
  normaliseRunControlMessage,
  RUN_CONTROL_COMMANDS
} from "../src/running/control-protocol.js";

test("normalises a Garmin planned-walk control message", () => {
  assert.deepEqual(normaliseRunControlMessage({
    type: "run-control",
    version: 1,
    source: "garmin",
    command: "planned-walk",
    requestId: "watch-42"
  }), {
    type: "run-control",
    version: 1,
    source: "garmin",
    command: "planned-walk",
    requestId: "watch-42"
  });
});

test("rejects unknown or dangerous watch commands", () => {
  assert.throws(() => normaliseRunControlMessage({
    type: "run-control",
    version: 1,
    source: "garmin",
    command: "delete-session"
  }), /Unsupported run-control command/);
});

test("shares all safe coach commands and creates a bounded acknowledgement", () => {
  assert.ok(RUN_CONTROL_COMMANDS.includes("finish-request"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("finish-confirm"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("switch-hip"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("switch-hand"));
  const message = normaliseRunControlMessage({
    type: "run-control", version: 1, command: "status", requestId: "abc"
  });
  assert.deepEqual(createRunControlAck(message, { accepted: true, detail: "Spoken on phone" }), {
    type: "run-control-ack",
    version: 1,
    requestId: "abc",
    command: "status",
    accepted: true,
    detail: "Spoken on phone"
  });
});
