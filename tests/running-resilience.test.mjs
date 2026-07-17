import assert from "node:assert/strict";
import test from "node:test";
import {
  closeInterruption, createInterruption, interruptionSummary,
  makePersistedSession, parsePersistedSession
} from "../src/running/session-resilience.js";
import { RunRhythmCoach } from "../src/running/rhythm-engine.js";

test("persists and validates a recent active run", () => {
  const payload = makePersistedSession({
    startedAtEpochMs: 1_000,
    savedAtEpochMs: 10_000,
    coachState: { version: 1 },
    interruptions: []
  });
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).startedAtEpochMs, 1_000);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 50_000, maxAgeMs: 20_000 }), null);
});

test("reports interruption count and missing duration honestly", () => {
  const first = closeInterruption(createInterruption({ reason: "hidden", startedAtEpochMs: 1_000 }), 4_000);
  const second = createInterruption({ reason: "motion-gap", startedAtEpochMs: 6_000 });
  assert.deepEqual(interruptionSummary([first, second], 10_000), { count: 2, totalMs: 7_000 });
});

test("restores rhythm-coach progress onto a new monotonic clock", () => {
  const coach = new RunRhythmCoach({ baselineDurationMs: 3_000, baselineMinSamples: 3, baselineSampleEveryMs: 1_000 });
  coach.start(1_000);
  coach.update({ timestampMs: 2_000, cadenceSpm: 170, movementState: "running" });
  coach.update({ timestampMs: 3_000, cadenceSpm: 171, movementState: "running" });
  const before = coach.update({ timestampMs: 4_000, cadenceSpm: 169, movementState: "running" });

  const restoredCoach = new RunRhythmCoach();
  const restored = restoredCoach.restoreState(coach.exportState(), 500);
  assert.equal(restored.baselineCadenceSpm, before.baselineCadenceSpm);
  assert.equal(restored.runningMs, before.runningMs);
  assert.equal(restored.timestampMs, 500);
  assert.equal(restoredCoach.update({ timestampMs: 1_500, cadenceSpm: 170, movementState: "running" }).runningMs, before.runningMs + 1_000);
});
