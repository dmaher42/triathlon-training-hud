import test from "node:test";
import assert from "node:assert/strict";
import {
  createRunControlAck,
  normaliseRunControlAction,
  normaliseRunControlMessage,
  RUN_COMPARISON_WINDOWS,
  RUN_CONTROL_COMMANDS,
  RUN_TERRAINS
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
  assert.ok(RUN_CONTROL_COMMANDS.includes("mark-change"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("technique-status"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("cancel-comparison"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("compare-recent"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("show-previous"));
  assert.ok(RUN_CONTROL_COMMANDS.includes("set-terrain"));
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

test("uses one normalized action shape for voice, touch and future Garmin controls", () => {
  assert.deepEqual(RUN_COMPARISON_WINDOWS, [1, 3, 5, 10]);
  assert.deepEqual(RUN_TERRAINS, [
    "unlabelled", "flat", "uphill", "downhill", "rolling", "trail", "treadmill"
  ]);
  assert.deepEqual(normaliseRunControlAction({
    intent: "compare-recent",
    windowMinutes: "5"
  }), {
    command: "compare-recent",
    windowMinutes: 5
  });
  assert.deepEqual(normaliseRunControlAction({
    command: "show-previous",
    windowMinutes: 3
  }), {
    command: "show-previous",
    windowMinutes: 3
  });
  assert.deepEqual(normaliseRunControlAction({
    command: "set-terrain",
    terrain: "UNEVEN"
  }), {
    command: "set-terrain",
    terrain: "trail"
  });
  assert.deepEqual(normaliseRunControlAction({ command: "mark-change" }), {
    command: "mark-change"
  });
});

test("normalises parameterised Garmin comparison and terrain messages", () => {
  assert.deepEqual(normaliseRunControlMessage({
    type: "run-control",
    version: 1,
    source: "garmin",
    command: "compare-recent",
    windowMinutes: 10,
    requestId: "watch-compare"
  }), {
    type: "run-control",
    version: 1,
    source: "garmin",
    command: "compare-recent",
    windowMinutes: 10,
    requestId: "watch-compare"
  });
  assert.deepEqual(normaliseRunControlMessage({
    type: "run-control",
    version: 1,
    command: "set-terrain",
    terrain: "uphill",
    requestId: "phone-terrain"
  }), {
    type: "run-control",
    version: 1,
    source: "companion",
    command: "set-terrain",
    terrain: "uphill",
    requestId: "phone-terrain"
  });
});

test("rejects incomplete or unsupported parameterised actions", () => {
  assert.throws(
    () => normaliseRunControlAction({ command: "compare-recent", windowMinutes: 2 }),
    /Unsupported comparison window/
  );
  assert.throws(
    () => normaliseRunControlAction({ command: "show-previous" }),
    /Unsupported comparison window/
  );
  assert.throws(
    () => normaliseRunControlAction({ command: "set-terrain", terrain: "mountain" }),
    /Unsupported terrain/
  );
});
