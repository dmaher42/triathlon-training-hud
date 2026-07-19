import assert from "node:assert/strict";
import test from "node:test";
import { ArmSwingAnalyzer } from "../src/running/arm-swing-analyzer.js";

function feedGyro(analyzer, {
  startAtMs = 0,
  durationMs = 10_000,
  periodMs = 700,
  amplitude = 80,
  cadenceSpm = null,
  cadenceSource = "none",
  recordingAllowed = true,
  stepMs = 50
} = {}) {
  let result;
  for (let at = startAtMs; at <= startAtMs + durationMs; at += stepMs) {
    const signal = amplitude * Math.sin((at - startAtMs) / periodMs * Math.PI * 2);
    result = analyzer.update({
      timestampMs: at,
      rotationRate: { alpha: signal, beta: signal * 0.08, gamma: 0 },
      accelerationIncludingGravity: { x: 0.2, y: 0, z: 9.81 },
      cadenceSpm,
      cadenceSource,
      recordingAllowed
    });
  }
  return result;
}

function feedAcceleration(analyzer, options = {}) {
  const {
    startAtMs = 0,
    durationMs = 10_000,
    periodMs = 700,
    amplitude = 2,
    stepMs = 50
  } = options;
  let result;
  for (let at = startAtMs; at <= startAtMs + durationMs; at += stepMs) {
    const signal = amplitude * Math.sin((at - startAtMs) / periodMs * Math.PI * 2);
    result = analyzer.update({
      timestampMs: at,
      acceleration: { x: signal, y: signal * 0.05, z: 0 },
      cadenceSpm: options.cadenceSpm ?? null,
      cadenceSource: options.cadenceSource ?? "none"
    });
  }
  return result;
}

function feedMixedMotion(analyzer, {
  startAtMs = 0,
  durationMs = 10_000,
  periodMs = 700,
  gyroAmplitude = 80,
  accelerationAmplitude = 2,
  gyroAxis = 0,
  accelerationAxis = 0,
  stepMs = 50
} = {}) {
  let result;
  for (let at = startAtMs; at <= startAtMs + durationMs; at += stepMs) {
    const phase = Math.sin((at - startAtMs) / periodMs * Math.PI * 2);
    const gyro = [0, 0, 0];
    const acceleration = [0, 0, 0];
    gyro[gyroAxis] = gyroAmplitude * phase;
    acceleration[accelerationAxis] = accelerationAmplitude * phase;
    result = analyzer.update({
      timestampMs: at,
      rotationRate: { alpha: gyro[0], beta: gyro[1], gamma: gyro[2] },
      acceleration: { x: acceleration[0], y: acceleration[1], z: acceleration[2] }
    });
  }
  return result;
}

function feedAsymmetricGyro(analyzer, { durationMs = 12_000, stepMs = 50 } = {}) {
  let result;
  for (let at = 0; at <= durationMs; at += stepMs) {
    const cycleMs = at % 700;
    const signal = cycleMs < 250 ? 80 : -80;
    result = analyzer.update({
      timestampMs: at,
      rotationRate: { alpha: signal, beta: 0, gamma: 0 }
    });
  }
  return result;
}

const quickConfig = {
  openingDurationMs: 3_000,
  minimumBaselineSwings: 5,
  recentWindowMs: 4_000,
  summaryIntervalMs: 0
};

test("measures a clean 172-step arm rhythm as about 86 arm cycles per minute", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 10_000, periodMs: 700 });
  const result = analyzer.snapshot(10_000, { force: true });
  assert.ok(result.equivalentCadenceSpm >= 168 && result.equivalentCadenceSpm <= 175);
  assert.ok(result.armCycleRpm >= 84 && result.armCycleRpm <= 88);
  assert.ok(result.regularityPercent >= 90);
  assert.equal(result.baselineReady, true);
});

test("changes the personal range index without changing arm rhythm", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 7_000, periodMs: 700, amplitude: 55 });
  feedGyro(analyzer, { startAtMs: 7_050, durationMs: 5_000, periodMs: 700, amplitude: 110 });
  const result = analyzer.snapshot(12_050, { force: true });
  assert.ok(result.rangeChangePercent > 30);
  assert.ok(result.equivalentCadenceSpm >= 168 && result.equivalentCadenceSpm <= 175);
});

test("shows cadence match only for a genuine Garmin cadence reference", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 8_000, cadenceSpm: 172, cadenceSource: "phone" });
  assert.equal(analyzer.snapshot(8_000, { force: true }).cadenceMatchPercent, null);
  feedGyro(analyzer, { startAtMs: 8_050, durationMs: 3_000, cadenceSpm: 172, cadenceSource: "garmin" });
  assert.ok(analyzer.snapshot(11_050, { force: true }).cadenceMatchPercent >= 97);
});

test("falls back to acceleration without inventing gyro capability", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedAcceleration(analyzer, { durationMs: 10_000 });
  const result = analyzer.snapshot(10_000, { force: true });
  assert.equal(result.capabilities.gyroAvailable, false);
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.ok(result.armCycleRpm >= 84 && result.armCycleRpm <= 88);
  assert.ok(result.confidence <= 68);
});

test("ignores a flat gyroscope and uses live acceleration", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedMixedMotion(analyzer, { durationMs: 10_000, gyroAmplitude: 0 });
  const result = analyzer.snapshot(10_000, { force: true });
  assert.equal(result.capabilities.gyroAvailable, false);
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.ok(result.armCycleRpm >= 84 && result.armCycleRpm <= 88);
});

test("uses dynamic gravity acceleration when linear acceleration is present but flat", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  for (let at = 0; at <= 10_000; at += 50) {
    const signal = 2 * Math.sin(at / 700 * Math.PI * 2);
    analyzer.update({
      timestampMs: at,
      acceleration: { x: 0, y: 0, z: 0 },
      accelerationIncludingGravity: { x: signal, y: 0, z: 9.81 }
    });
  }
  const result = analyzer.snapshot(10_000, { force: true });
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.ok(result.armCycleRpm >= 84 && result.armCycleRpm <= 88);
});

test("locks one sensor source so a later gyroscope cannot corrupt the range baseline", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedAcceleration(analyzer, { durationMs: 8_000, amplitude: 2 });
  feedMixedMotion(analyzer, {
    startAtMs: 8_050,
    durationMs: 5_000,
    gyroAmplitude: 120,
    accelerationAmplitude: 2
  });
  const result = analyzer.snapshot(13_050, { force: true });
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.equal(result.capabilities.gyroAvailable, false);
  assert.ok(Math.abs(result.rangeChangePercent) < 25);
});

test("scores a repeatable asymmetric swing as regular instead of comparing opposite phases", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedAsymmetricGyro(analyzer);
  const result = analyzer.snapshot(12_000, { force: true });
  assert.ok(result.equivalentCadenceSpm >= 168 && result.equivalentCadenceSpm <= 175);
  assert.ok(result.regularityPercent >= 90);
});

test("keeps range comparison unavailable after the phone changes grip axis", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 8_000, amplitude: 80 });
  feedMixedMotion(analyzer, {
    startAtMs: 8_050,
    durationMs: 5_000,
    gyroAmplitude: 80,
    accelerationAmplitude: 0,
    gyroAxis: 1
  });
  let result = analyzer.snapshot(13_050, { force: true });
  assert.equal(result.placementConsistent, false);
  assert.equal(result.rangeChangePercent, null);

  feedMixedMotion(analyzer, {
    startAtMs: 13_100,
    durationMs: 4_000,
    gyroAmplitude: 80,
    accelerationAmplitude: 0,
    gyroAxis: 0
  });
  result = analyzer.snapshot(17_100, { force: true });
  assert.equal(result.placementConsistent, false);
  assert.equal(result.rangeChangePercent, null);
});

test("walking rhythm and a planned pause do not advance the running baseline", () => {
  const walking = new ArmSwingAnalyzer(quickConfig);
  walking.start(0);
  feedGyro(walking, { durationMs: 10_000, periodMs: 1_200 });
  assert.equal(walking.snapshot(10_000, { force: true }).runningElapsedMs, 0);
  assert.equal(walking.snapshot(10_000, { force: true }).confidence, 0);

  const paused = new ArmSwingAnalyzer(quickConfig);
  paused.start(0);
  feedGyro(paused, { durationMs: 10_000, recordingAllowed: false });
  const pausedResult = paused.snapshot(10_000, { force: true });
  assert.equal(pausedResult.runningElapsedMs, 0);
  assert.equal(pausedResult.totalSwings, 0);
});

test("restores aggregate progress without counting an app-closure gap", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 8_000 });
  const before = analyzer.snapshot(8_000, { force: true });
  const restoredAnalyzer = new ArmSwingAnalyzer();
  const restored = restoredAnalyzer.restoreState(analyzer.exportState(), 50_000);
  assert.equal(restored.runningElapsedMs, before.runningElapsedMs);
  assert.equal(restored.opening.swingCount, before.opening.swingCount);
  assert.equal(restored.equivalentCadenceSpm, null);
  assert.equal(restored.capabilities.signalSource, "gyro");
});

test("restores the locked source and will not mix measurement units after a reload", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedAcceleration(analyzer, { durationMs: 8_000 });
  const restoredAnalyzer = new ArmSwingAnalyzer();
  restoredAnalyzer.restoreState(analyzer.exportState(), 50_000);
  feedMixedMotion(restoredAnalyzer, {
    startAtMs: 50_050,
    durationMs: 4_000,
    gyroAmplitude: 120,
    accelerationAmplitude: 2
  });
  const result = restoredAnalyzer.snapshot(54_050, { force: true });
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.equal(result.capabilities.gyroAvailable, false);
});

test("reselects safely when an older acceleration state did not record its vector type", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedAcceleration(analyzer, { durationMs: 8_000 });
  const legacyState = analyzer.exportState();
  legacyState.version = 1;
  delete legacyState.state.accelerationMode;

  const restoredAnalyzer = new ArmSwingAnalyzer();
  const restored = restoredAnalyzer.restoreState(legacyState, 50_000);
  assert.equal(restored.capabilities.signalSource, null);
  for (let at = 50_050; at <= 56_050; at += 50) {
    const signal = 2 * Math.sin((at - 50_050) / 700 * Math.PI * 2);
    restoredAnalyzer.update({
      timestampMs: at,
      accelerationIncludingGravity: { x: signal, y: 0, z: 9.81 }
    });
  }
  const result = restoredAnalyzer.snapshot(56_050, { force: true });
  assert.equal(result.capabilities.signalSource, "acceleration");
  assert.equal(result.placementConsistent, false);
  assert.equal(result.rangeChangePercent, null);
});

test("missing motion vectors remain unavailable instead of becoming zero", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  const result = analyzer.update({ timestampMs: 100, rotationRate: null, acceleration: null });
  assert.equal(result.armCycleRpm, null);
  assert.equal(result.regularityPercent, null);
  assert.equal(result.capabilities.signalSource, null);
  assert.equal(result.totalSamples, 0);
});

test("queries exact half-open arm-swing comparison windows", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  analyzer.addComparisonSwing({ atMs: 1_000, intervalMs: 350, rangeValue: 20, direction: 1 });
  analyzer.addComparisonSwing({ atMs: 1_500, intervalMs: 350, rangeValue: 22, direction: -1 });
  analyzer.addComparisonSwing({ atMs: 2_000, intervalMs: 350, rangeValue: 24, direction: 1 });

  const result = analyzer.windowMetrics(1_000, 2_000);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.observedBucketCount, 1);
  assert.equal(result.expectedBucketCount, 1);
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.metrics.rangeMean, 21);
  assert.equal(analyzer.windowMetrics(2_000, 3_000).sampleCount, 1);
  assert.throws(() => analyzer.windowMetrics(1_100, 2_100), /one-second boundaries/);
});

test("retains complete 1, 3, 5, and 10 minute arm-swing windows", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  for (let at = 350; at < 10 * 60_000; at += 1_000) {
    const direction = Math.floor(at / 1_000) % 2 ? 1 : -1;
    analyzer.addComparisonSwing({ atMs: at, intervalMs: 350, rangeValue: 20, direction });
  }
  for (const minutes of [1, 3, 5, 10]) {
    const durationMs = minutes * 60_000;
    const result = analyzer.windowMetrics(10 * 60_000 - durationMs, 10 * 60_000);
    assert.equal(result.durationMs, durationMs);
    assert.equal(result.sampleCount, minutes * 60);
    assert.equal(result.observedBucketCount, minutes * 60);
    assert.equal(result.expectedBucketCount, minutes * 60);
    assert.equal(result.coverageRatio, 1);
  }
});

test("comparison history does not widen the normal recent arm-swing metrics", () => {
  const analyzer = new ArmSwingAnalyzer({ ...quickConfig, recentWindowMs: 2_000 });
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 10_000, periodMs: 700 });
  const recent = analyzer.snapshot(10_000, { force: true }).recent;
  const comparison = analyzer.windowMetrics(0, 10_000);
  assert.ok(recent.swingCount < comparison.sampleCount);
  assert.ok(analyzer.recentMeasurements.every(swing => swing.atMs >= 8_000));
});

test("planned pauses and non-running hand rhythm do not enter comparison windows", () => {
  const walking = new ArmSwingAnalyzer(quickConfig);
  walking.start(0);
  feedGyro(walking, { durationMs: 5_000, periodMs: 1_200 });
  assert.equal(walking.windowMetrics(0, 6_000).sampleCount, 0);

  const paused = new ArmSwingAnalyzer(quickConfig);
  paused.start(0);
  feedGyro(paused, { durationMs: 5_000, recordingAllowed: false });
  assert.equal(paused.windowMetrics(0, 6_000).sampleCount, 0);
});

test("restores compact arm-swing comparison windows without raw swings", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 8_000 });
  const before = analyzer.windowMetrics(0, 8_000);
  const exported = analyzer.exportState();
  assert.ok(Array.isArray(exported.state.comparisonBuckets[0]));
  assert.equal("recentMeasurements" in exported.state, false);
  assert.equal("liveSwings" in exported.state, false);

  const restored = new ArmSwingAnalyzer();
  restored.restoreState(exported, 50_000);
  const after = restored.windowMetrics(42_000, 50_000);
  assert.equal(after.sampleCount, before.sampleCount);
  assert.deepEqual(after.metrics, before.metrics);
});

test("restores the previous arm-swing state format", () => {
  const analyzer = new ArmSwingAnalyzer(quickConfig);
  analyzer.start(0);
  feedGyro(analyzer, { durationMs: 8_000 });
  const legacy = analyzer.exportState();
  legacy.version = 2;
  delete legacy.state.lastSampleAtMs;
  delete legacy.state.comparisonBuckets;

  const restored = new ArmSwingAnalyzer();
  const result = restored.restoreState(legacy, 50_000);
  assert.ok(result.opening.swingCount > 0);
  assert.equal(restored.windowMetrics(49_000, 50_000).sampleCount, 0);
});

test("keeps a simulated hour bounded and fast enough for hand-held operation", () => {
  const analyzer = new ArmSwingAnalyzer();
  analyzer.start(0);
  const started = performance.now();
  feedGyro(analyzer, { durationMs: 60 * 60_000, periodMs: 700, stepMs: 100 });
  const computeMs = performance.now() - started;
  const stateBytes = Buffer.byteLength(JSON.stringify(analyzer.exportState()));
  assert.ok(computeMs < 5_000, `simulated hour took ${Math.round(computeMs)}ms`);
  assert.ok(stateBytes < 150_000, `saved state grew to ${stateBytes} bytes`);
  assert.ok(analyzer.recentMeasurements.length <= 120);
  assert.ok(analyzer.liveSwings.length <= 40);
  assert.ok(analyzer.comparisonBuckets.length <= 1_201);
  const lastTwentyMinutes = analyzer.windowMetrics(40 * 60_000, 60 * 60_000);
  assert.equal(lastTwentyMinutes.expectedBucketCount, 1_200);
  assert.equal(lastTwentyMinutes.observedBucketCount, 1_200);
});
