import assert from "node:assert/strict";
import test from "node:test";
import {
  closeInterruption, createInterruption, interruptionSummary,
  makeCompletedRun, makePersistedSession, parseCompletedRun, parsePersistedSession
} from "../src/running/session-resilience.js";
import { RunRhythmCoach } from "../src/running/rhythm-engine.js";

test("persists and validates a recent active run", () => {
  const payload = makePersistedSession({
    startedAtEpochMs: 1_000,
    savedAtEpochMs: 10_000,
    coachState: { version: 1 },
    formState: { version: 1 },
    armState: { version: 1 },
    phonePlacement: "hand",
    pocketSide: "left",
    interruptions: [],
    techniqueState: { version: 1, windowMs: 300_000 },
    terrain: "rolling",
    comparisonWindowMs: 300_000
  });
  payload.placementSwitchCount = 2;
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).startedAtEpochMs, 1_000);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).pocketSide, "left");
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).phonePlacement, "hand");
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).armState.version, 1);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).formState.version, 1);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).placementSwitchCount, 2);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).terrain, "rolling");
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).comparisonWindowMs, 300_000);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 12_000 }).techniqueState.version, 1);
  assert.equal(parsePersistedSession(JSON.stringify(payload), { nowEpochMs: 50_000, maxAgeMs: 20_000 }), null);
});

test("restores legacy saved runs as hip-pocket sessions", () => {
  const legacy = {
    version: 1,
    active: true,
    startedAtEpochMs: 1_000,
    savedAtEpochMs: 10_000,
    coachState: { version: 1 },
    formState: { version: 2 },
    pocketSide: "left",
    interruptions: []
  };
  const restored = parsePersistedSession(legacy, { nowEpochMs: 12_000 });
  assert.equal(restored.phonePlacement, "hip");
  assert.equal(restored.pocketSide, "left");
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

test("persists and restores a complete finished-run review", () => {
  const first = closeInterruption(createInterruption({ reason: "hidden", startedAtEpochMs: 2_000 }), 3_000);
  const completed = makeCompletedRun({
    completedAtEpochMs: 20_000,
    elapsedMs: 18_000,
    runSnapshot: {
      status: "REVIEW",
      message: "Run complete.",
      cadenceSpm: 170,
      baselineCadenceSpm: 168,
      stablePercent: 82,
      unplannedWalks: 1,
      stopCount: 2,
      events: [{ type: "old-event" }]
    },
    motionSnapshot: { version: 2, baselineReady: true, confidencePercent: 91 },
    phonePlacement: "hand",
    pocketSide: "left",
    placementSwitchCount: 2,
    interruptions: [first],
    techniqueComparisons: [{ id: "technique-1", status: "complete" }],
    terrainSegments: [{ id: 1, terrain: "flat", startMs: 0, endMs: null }],
    comparisonWindowMs: 300_000,
    retrospectiveComparison: { available: true, quality: "high" }
  });
  const restored = parseCompletedRun(JSON.stringify(completed));

  assert.equal(restored.version, 4);
  assert.equal(restored.elapsedMs, 18_000);
  assert.equal(restored.runSnapshot.status, "REVIEW");
  assert.equal(restored.runSnapshot.stablePercent, 82);
  assert.equal(restored.runSnapshot.unplannedWalks, 1);
  assert.deepEqual(restored.runSnapshot.events, []);
  assert.equal(restored.snapshot.confidencePercent, 91);
  assert.equal(restored.phonePlacement, "hand");
  assert.equal(restored.pocketSide, "left");
  assert.equal(restored.placementSwitchCount, 2);
  assert.equal(restored.techniqueComparisons[0].id, "technique-1");
  assert.equal(restored.terrainSegments[0].terrain, "flat");
  assert.equal(restored.comparisonWindowMs, 300_000);
  assert.equal(restored.retrospectiveComparison.quality, "high");
  assert.deepEqual(interruptionSummary(restored.interruptions, 20_000), { count: 1, totalMs: 1_000 });
});

test("keeps legacy motion reports readable without inventing a full review", () => {
  const legacy = parseCompletedRun({
    version: 2,
    completedAtEpochMs: 20_000,
    phonePlacement: "hand",
    pocketSide: "right",
    snapshot: { version: 2, baselineReady: true }
  });
  assert.equal(legacy.phonePlacement, "hand");
  assert.equal(legacy.runSnapshot, undefined);
  assert.equal(legacy.snapshot.baselineReady, true);
});

test("rejects incomplete version-three finished runs", () => {
  assert.equal(parseCompletedRun({
    version: 3,
    completedAtEpochMs: 20_000,
    elapsedMs: 18_000,
    snapshot: { version: 2 }
  }), null);
});
