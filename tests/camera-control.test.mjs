import assert from "node:assert/strict";
import test from "node:test";
import { CAMERA_MANUAL_HOLD_MS, cameraLearningAnswerForKey, decideCameraTimerAction, nextCameraAeroPosition, shouldWaitForAeroAfterBreak } from "../src/camera-control.js";

const decision = overrides => decideCameraTimerAction({
  enabled: true,
  stableState: "uncertain",
  rideState: "aero",
  intervalComplete: false,
  rideTargetReached: false,
  manualHoldActive: false,
  ...overrides
});

test("stable upright pauses an active Aero timer", () => {
  assert.equal(decision({ stableState: "upright" }), "pause");
});

test("stable Aero resumes a camera-paused timer", () => {
  assert.equal(decision({ stableState: "aero", rideState: "paused" }), "resume");
});

test("uncertain camera state preserves the current timer state", () => {
  assert.equal(decision({ stableState: "uncertain" }), null);
  assert.equal(decision({ stableState: "uncertain", rideState: "paused" }), null);
});

test("manual override and a completed ride block automatic changes", () => {
  assert.equal(CAMERA_MANUAL_HOLD_MS, 8000);
  assert.equal(decision({ stableState: "upright", manualHoldActive: true }), null);
  assert.equal(decision({ stableState: "upright", rideTargetReached: true }), null);
  assert.equal(decision({ stableState: "upright", rideState: "action" }), null);
});

test("camera position tracking continues after an Aero interval completes", () => {
  assert.equal(decision({ stableState: "upright", intervalComplete: true }), "pause");
  assert.equal(decision({ stableState: "aero", rideState: "paused", intervalComplete: true }), "resume");
});

test("a fully paused ride cannot be changed by camera automation", () => {
  assert.equal(decision({ stableState: "aero", rideState: "ride-paused" }), null);
  assert.equal(decision({ stableState: "upright", rideState: "ride-paused" }), null);
});

test("break completion waits for a confirmed Aero position", () => {
  assert.equal(shouldWaitForAeroAfterBreak({ enabled: true, stableState: "upright" }), true);
  assert.equal(shouldWaitForAeroAfterBreak({ enabled: true, stableState: "uncertain" }), true);
  assert.equal(shouldWaitForAeroAfterBreak({ enabled: true, stableState: "aero" }), false);
  assert.equal(shouldWaitForAeroAfterBreak({ enabled: false, stableState: "upright" }), false);
});

test("camera learning prompts can be answered with one riding-friendly key", () => {
  assert.equal(cameraLearningAnswerForKey("Enter"), true);
  assert.equal(cameraLearningAnswerForKey("ArrowLeft"), true);
  assert.equal(cameraLearningAnswerForKey("ArrowUp"), true);
  assert.equal(cameraLearningAnswerForKey("ArrowRight"), false);
  assert.equal(cameraLearningAnswerForKey("ArrowDown"), false);
  assert.equal(cameraLearningAnswerForKey("Space"), null);
});

test("camera posture drives Overall Aero independently of interval or action state", () => {
  assert.equal(nextCameraAeroPosition({ enabled: true, stableState: "aero", currentlyAero: false }), true);
  assert.equal(nextCameraAeroPosition({ enabled: true, stableState: "upright", currentlyAero: true }), false);
  assert.equal(nextCameraAeroPosition({ enabled: true, stableState: "uncertain", currentlyAero: true }), true);
  assert.equal(nextCameraAeroPosition({ enabled: false, stableState: "upright", currentlyAero: true }), true);
});
