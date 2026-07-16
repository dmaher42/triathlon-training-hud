import assert from "node:assert/strict";
import test from "node:test";
import { getLiveChallenge, getPersonalBest, getPlanStatus, getPositionTimes, getRidePhase } from "../src/ride-phases.js";

test("ride phases advance evenly across the planned ride", () => {
  assert.equal(getRidePhase(0, 6000).name, "Warm Up");
  assert.equal(getRidePhase(1200, 6000).name, "Build");
  assert.equal(getRidePhase(3000, 6000).name, "Race Rhythm");
  assert.equal(getRidePhase(5999, 6000).name, "Finish Strong");
  assert.equal(getRidePhase(7000, 6000).index, 4);
});

test("challenge targets the next reminder when it arrives before the interval ends", () => {
  const challenge = getLiveChallenge({
    reminderRows: [{ type: "fuel", remaining: 600 }, { type: "water", remaining: 120 }],
    intervalRemainingSec: 300,
    intervalElapsedSec: 240
  });
  assert.equal(challenge.label, "Hold Aero to Water");
  assert.equal(challenge.remainingSec, 120);
});

test("challenge keeps the Aero interval target when it arrives first", () => {
  const challenge = getLiveChallenge({ reminderRows: [{ type: "water", remaining: 600 }], intervalRemainingSec: 90 });
  assert.equal(challenge.label, "Complete Aero Interval");
  assert.equal(challenge.remainingSec, 90);
});

test("personal best includes saved and current ride intervals", () => {
  assert.equal(getPersonalBest([{ bestIntervalSeconds: 720 }, { bestIntervalSeconds: 840 }], 600), 840);
  assert.equal(getPersonalBest([], 300), 300);
});

test("overall time is always split between Aero and upright time", () => {
  assert.deepEqual(getPositionTimes(600_000, 420_000), { overallMs: 600_000, aeroMs: 420_000, uprightMs: 180_000 });
  assert.deepEqual(getPositionTimes(60_000, 90_000), { overallMs: 60_000, aeroMs: 60_000, uprightMs: 0 });
  assert.deepEqual(getPositionTimes(3_100, 1_600), { overallMs: 3_000, aeroMs: 1_000, uprightMs: 2_000 });
});

test("plan status distinguishes on-time and review-needed actions", () => {
  assert.equal(getPlanStatus([{ status: "done", originalDueAtSec: 600, completedAtSec: 650 }], []).text, "ON PLAN • 1 ACTION ON TIME");
  assert.equal(getPlanStatus([{ status: "skipped" }], []).tone, "attention");
  assert.equal(getPlanStatus([], [{ type: "water" }, { type: "fuel" }]).text, "ON PLAN • 2 ACTIONS RECORDED");
});
