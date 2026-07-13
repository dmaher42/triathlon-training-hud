import assert from "node:assert/strict";
import test from "node:test";
import { CameraObserver } from "../src/camera-observer.js";

const makeSamples = (kind, count = 35) => Array.from({ length: count }, (_, index) => {
  const wobble = ((index % 7) - 3) / 20;
  return kind === "aero" ? {
    torsoAngle: 54 + wobble,
    torsoOffset: .48 + wobble / 20,
    worldTorsoTilt: 49 + wobble,
    headOffset: .56 + wobble / 20,
    armWristHeight: -.08 + wobble / 20,
    armElbowAngle: 92 + wobble
  } : {
    torsoAngle: 12 + wobble,
    torsoOffset: .08 + wobble / 20,
    worldTorsoTilt: 16 + wobble,
    headOffset: .13 + wobble / 20,
    armWristHeight: .3 + wobble / 20,
    armElbowAngle: 148 + wobble
  };
});

test("calibration separates Aero and upright samples", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { upright: makeSamples("upright"), aero: makeSamples("aero"), profile: null, quality: 0 };
  const result = observer.finalizeCalibration();

  assert.ok(result.quality >= 70);
  assert.equal(observer.classify({ features: makeSamples("aero", 1)[0], quality: .95 }).state, "aero");
  assert.equal(observer.classify({ features: makeSamples("upright", 1)[0], quality: .95 }).state, "upright");
});

test("missing pose stays uncertain instead of changing a timer state", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { upright: makeSamples("upright"), aero: makeSamples("aero"), profile: null, quality: 0 };
  observer.finalizeCalibration();
  const result = observer.classify(null);

  assert.equal(result.state, "uncertain");
  assert.equal(result.confidence, 0);
});

test("dropping the head does not invalidate an otherwise stable Aero torso", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { upright: makeSamples("upright"), aero: makeSamples("aero"), profile: null, quality: 0 };
  observer.finalizeCalibration();
  const aeroWithDroppedHead = { ...makeSamples("aero", 1)[0], headOffset: 4.5 };

  assert.equal(observer.calibration.profile.headOffset, undefined);
  assert.equal(observer.classify({ features: aeroWithDroppedHead, quality: .9 }).state, "aero");
});

test("Aero arm support tolerates normal torso movement", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { upright: makeSamples("upright"), aero: makeSamples("aero"), profile: null, quality: 0 };
  observer.finalizeCalibration();
  const movingAero = {
    ...makeSamples("aero", 1)[0],
    torsoAngle: 34,
    torsoOffset: .28,
    worldTorsoTilt: 32
  };

  assert.equal(observer.classify({ features: movingAero, quality: .9 }).state, "aero");
});

test("Aero-looking arms cannot overrule a clearly upright torso", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { upright: makeSamples("upright"), aero: makeSamples("aero"), profile: null, quality: 0 };
  observer.finalizeCalibration();
  const conflictingPose = {
    ...makeSamples("upright", 1)[0],
    armWristHeight: makeSamples("aero", 1)[0].armWristHeight,
    armElbowAngle: makeSamples("aero", 1)[0].armElbowAngle
  };

  assert.equal(observer.classify({ features: conflictingPose, quality: .9 }).state, "uncertain");
});

test("session summary records only derived posture timing", () => {
  const observer = new CameraObserver({ video: {} });
  observer.calibration = { quality: 90, profile: {} };
  observer.stableState = "aero";
  observer.beginSession();
  observer.setSessionContext({ rideSec: 1, manualAero: true });
  observer.integrateSession(observer.lastSessionAt + 500);
  observer.setSessionContext({ rideSec: 1.5, manualAero: true });
  const summary = observer.endSession(1.5);

  assert.equal(summary.enabled, true);
  assert.ok(summary.detectedAeroSeconds >= .49);
  assert.equal(summary.agreementPercent, 100);
  assert.equal("video" in summary, false);
  assert.equal("landmarks" in summary, false);
});
