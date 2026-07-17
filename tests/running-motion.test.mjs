import assert from "node:assert/strict";
import test from "node:test";
import { HipMotionCadenceDetector } from "../src/running/motion-cadence.js";
import { GARMIN_TELEMETRY_VERSION, RunSignalFusion, normalizeGarminTelemetry } from "../src/running/signal-fusion.js";

function feedSteps(detector, { intervalMs, count, startAtMs = 0 }) {
  let snapshot;
  for (let index = 0; index < count; index += 1) {
    const at = startAtMs + index * intervalMs;
    detector.updateMagnitude(at, 1.5);
    snapshot = detector.updateMagnitude(at + 70, 0.1);
  }
  return snapshot;
}

test("estimates running cadence from orientation-independent motion peaks", () => {
  const detector = new HipMotionCadenceDetector();
  const snapshot = feedSteps(detector, { intervalMs: 353, count: 16 });
  assert.ok(snapshot.cadenceSpm >= 168 && snapshot.cadenceSpm <= 172);
  assert.equal(snapshot.movementState, "running");
});

test("distinguishes a walking rhythm and a sustained stop", () => {
  const detector = new HipMotionCadenceDetector();
  const walking = feedSteps(detector, { intervalMs: 600, count: 10 });
  assert.equal(walking.cadenceSpm, 100);
  assert.equal(walking.movementState, "walking");
  assert.equal(detector.snapshot(9 * 600 + 3_000).movementState, "stopped");
});

test("normalises the versioned Garmin companion message", () => {
  assert.deepEqual(normalizeGarminTelemetry({
    type: "run-telemetry",
    version: GARMIN_TELEMETRY_VERSION,
    timestampMs: 1_000,
    cadenceSpm: "172",
    heartRateBpm: 145,
    speedMps: 3.2,
    timerState: "running"
  }), {
    type: "run-telemetry",
    version: 1,
    timestampMs: 1_000,
    cadenceSpm: 172,
    heartRateBpm: 145,
    speedMps: 3.2,
    timerState: "running"
  });
});

test("prefers fresh Garmin cadence while retaining phone hip-motion context", () => {
  const fusion = new RunSignalFusion({ garminFreshMs: 5_000 });
  fusion.updatePhone({ timestampMs: 1_000, cadenceSpm: 164, movementState: "running", motionIntensity: 1.4 });
  const live = fusion.updateGarmin({
    type: "run-telemetry",
    version: 1,
    timestampMs: 1_200,
    cadenceSpm: 172,
    heartRateBpm: 145,
    speedMps: 3.1,
    timerState: "running"
  });
  assert.equal(live.cadenceSource, "garmin");
  assert.equal(live.cadenceSpm, 172);
  assert.equal(live.motionIntensity, 1.4);
  assert.equal(live.garminConnected, true);

  const fallback = fusion.snapshot(7_000);
  assert.equal(fallback.cadenceSource, "phone");
  assert.equal(fallback.cadenceSpm, 164);
  assert.equal(fallback.garminConnected, false);
});

test("reports no cadence source before either device has supplied cadence", () => {
  const fusion = new RunSignalFusion();
  const empty = fusion.snapshot(1_000);
  assert.equal(empty.cadenceSource, "none");
  assert.equal(empty.cadenceSpm, null);

  const waitingForSteps = fusion.updatePhone({
    timestampMs: 1_100,
    cadenceSpm: null,
    movementState: "unknown",
    motionIntensity: 0.2
  });
  assert.equal(waitingForSteps.cadenceSource, "none");
  assert.equal(waitingForSteps.cadenceSpm, null);
});
