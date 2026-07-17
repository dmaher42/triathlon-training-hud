import assert from "node:assert/strict";
import test from "node:test";
import { RunRhythmCoach } from "../src/running/rhythm-engine.js";

function makeCoach() {
  return new RunRhythmCoach({
    baselineDurationMs: 3_000,
    baselineSampleEveryMs: 1_000,
    baselineMinSamples: 3,
    driftHoldMs: 2_000,
    recoveryHoldMs: 1_000,
    walkHoldMs: 1_500,
    stopHoldMs: 1_000,
    cueCooldownMs: 0,
    maxSampleGapMs: 1_000
  });
}

function learnBaseline(coach) {
  coach.start(0);
  coach.update({ timestampMs: 1_000, cadenceSpm: 169, movementState: "running" });
  coach.update({ timestampMs: 2_000, cadenceSpm: 170, movementState: "running" });
  return coach.update({ timestampMs: 3_000, cadenceSpm: 171, movementState: "running" });
}

test("keeps missing cadence empty while the phone is waiting for steps", () => {
  const coach = makeCoach();
  coach.start(0);
  const waiting = coach.update({ timestampMs: 250, cadenceSpm: null, movementState: "unknown" });
  assert.equal(waiting.cadenceSpm, null);
});

test("learns a personal cadence baseline from steady running samples", () => {
  const snapshot = learnBaseline(makeCoach());
  assert.equal(snapshot.baselineCadenceSpm, 170);
  assert.equal(snapshot.baselineProgress, 100);
  assert.equal(snapshot.status, "STEADY");
  assert.equal(snapshot.events.at(-1).type, "baseline-ready");
});

test("requires sustained cadence loss before coaching rhythm fade", () => {
  const coach = makeCoach();
  learnBaseline(coach);
  assert.equal(coach.update({ timestampMs: 4_000, cadenceSpm: 155, movementState: "running" }).driftActive, false);
  assert.equal(coach.update({ timestampMs: 5_000, cadenceSpm: 155, movementState: "running" }).driftActive, false);
  const faded = coach.update({ timestampMs: 6_000, cadenceSpm: 155, movementState: "running" });
  assert.equal(faded.driftActive, true);
  assert.equal(faded.status, "FADING");
  assert.equal(faded.events.at(-1).type, "rhythm-fading");

  coach.update({ timestampMs: 7_000, cadenceSpm: 168, movementState: "running" });
  const recovered = coach.update({ timestampMs: 8_000, cadenceSpm: 168, movementState: "running" });
  assert.equal(recovered.driftActive, false);
  assert.equal(recovered.status, "STEADY");
  assert.equal(recovered.events.at(-1).type, "rhythm-recovered");
});

test("counts sustained unplanned walking once and recognises the return to running", () => {
  const coach = makeCoach();
  learnBaseline(coach);
  coach.update({ timestampMs: 4_000, cadenceSpm: 105, movementState: "walking" });
  const walking = coach.update({ timestampMs: 5_500, cadenceSpm: 104, movementState: "walking" });
  assert.equal(walking.unplannedWalks, 1);
  assert.equal(walking.status, "WALKING");
  assert.equal(walking.events.at(-1).type, "unplanned-walk");
  assert.equal(coach.update({ timestampMs: 7_000, cadenceSpm: 101, movementState: "walking" }).unplannedWalks, 1);

  const resumed = coach.update({ timestampMs: 8_000, cadenceSpm: 168, movementState: "running" });
  assert.equal(resumed.events.at(-1).type, "running-resumed");
});

test("planned walking does not count against continuity", () => {
  const coach = makeCoach();
  learnBaseline(coach);
  coach.markPlannedBreak(3_500, 10_000);
  coach.update({ timestampMs: 4_000, cadenceSpm: 100, movementState: "walking" });
  const planned = coach.update({ timestampMs: 5_500, cadenceSpm: 100, movementState: "walking" });
  assert.equal(planned.unplannedWalks, 0);
  assert.equal(planned.status, "PLANNED WALK");
  assert.equal(planned.plannedBreakActive, true);
});

test("stable-running summary is based on learned rhythm rather than total session time", () => {
  const coach = makeCoach();
  learnBaseline(coach);
  coach.update({ timestampMs: 4_000, cadenceSpm: 170, movementState: "running" });
  coach.update({ timestampMs: 5_000, cadenceSpm: 150, movementState: "running" });
  const snapshot = coach.update({ timestampMs: 6_000, cadenceSpm: 150, movementState: "running" });
  assert.equal(snapshot.runningMs, 6_000);
  assert.equal(snapshot.stableRunningMs, undefined);
  assert.equal(snapshot.stablePercent, 67);
  assert.ok(snapshot.longestStableBlockMs >= 4_000);
});
