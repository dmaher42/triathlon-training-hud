import assert from "node:assert/strict";
import test from "node:test";
import { HipFormAnalyzer } from "../src/running/hip-form-analyzer.js";

function sample(analyzer, at, { vertical = 1, horizontal = 0.5, rotation = 10, running = true } = {}) {
  return analyzer.update({
    timestampMs: at,
    accelerationIncludingGravity: { x: horizontal * (Math.floor(at / 100) % 2 ? -1 : 1), y: 0, z: 9.81 + vertical * (Math.floor(at / 100) % 2 ? -1 : 1) },
    rotationRate: { alpha: rotation, beta: 0, gamma: 0 },
    movementState: running ? "running" : "walking",
    stepDetected: at % 300 === 0
  });
}

test("learns an opening hip-motion baseline without producing coaching judgments", () => {
  const analyzer = new HipFormAnalyzer({
    openingDurationMs: 500,
    rollingWindowMs: 500,
    minimumBaselineSamples: 6,
    expectedSampleRateHz: 10,
    minimumSampleIntervalMs: 90,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  let result;
  for (let at = 0; at <= 500; at += 100) result = sample(analyzer, at);
  assert.equal(result.baselineReady, true);
  assert.equal(result.baselineProgress, 100);
  assert.ok(result.opening.verticalRms > 0);
  assert.ok(result.opening.horizontalRms > 0);
  assert.equal("status" in result, false);
});

test("compares recent movement with the opening baseline", () => {
  const analyzer = new HipFormAnalyzer({
    openingDurationMs: 500,
    rollingWindowMs: 400,
    minimumBaselineSamples: 6,
    expectedSampleRateHz: 10,
    minimumSampleIntervalMs: 90,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  for (let at = 0; at <= 500; at += 100) sample(analyzer, at, { vertical: 0.8, horizontal: 0.4, rotation: 8 });
  let result;
  for (let at = 1_000; at <= 1_500; at += 100) result = sample(analyzer, at, { vertical: 1.6, horizontal: 0.8, rotation: 16 });
  assert.ok(result.drift.verticalPercent > 30);
  assert.ok(result.drift.horizontalPercent > 30);
  assert.ok(result.drift.rotationPercent > 30);
});

test("ignores walking samples and restores accumulated measurements", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, minimumBaselineSamples: 3, summaryIntervalMs: 0 });
  analyzer.start(100);
  sample(analyzer, 100, { running: false });
  sample(analyzer, 200);
  sample(analyzer, 300);
  assert.equal(analyzer.snapshot(300).opening.sampleCount, 2);

  const restored = new HipFormAnalyzer();
  const result = restored.restoreState(analyzer.exportState(), 1_000);
  assert.equal(result.opening.sampleCount, 2);
  assert.equal(result.totalSamples, 3);
});

test("retains opening, middle, and late segment summaries", () => {
  const analyzer = new HipFormAnalyzer({
    openingDurationMs: 200,
    middleEndMs: 500,
    minimumSampleIntervalMs: 90,
    minimumBaselineSamples: 2,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  sample(analyzer, 100);
  sample(analyzer, 200);
  sample(analyzer, 400, { vertical: 1.4 });
  sample(analyzer, 600, { vertical: 1.6 });
  sample(analyzer, 800, { vertical: 1.8 });
  const result = analyzer.snapshot(800, { force: true });
  assert.equal(result.segments.opening.sampleCount, 2);
  assert.equal(result.segments.middle.sampleCount, 2);
  assert.equal(result.segments.late.sampleCount, 1);
  assert.equal(result.phase, "late");
});

test("requires the full opening running duration as well as enough samples", () => {
  const analyzer = new HipFormAnalyzer({
    openingDurationMs: 1_000,
    minimumBaselineSamples: 2,
    minimumSampleIntervalMs: 90,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  let result;
  for (let at = 0; at <= 900; at += 100) result = sample(analyzer, at);
  assert.equal(result.baselineReady, false);
  sample(analyzer, 1_000, { running: false });
  sample(analyzer, 1_100);
  result = sample(analyzer, 1_200);
  assert.equal(result.baselineReady, true);
});

test("marks rotation unavailable instead of treating missing gyro data as zero", () => {
  const analyzer = new HipFormAnalyzer({ openingDurationMs: 200, minimumBaselineSamples: 2, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at <= 300; at += 100) {
    analyzer.update({
      timestampMs: at,
      accelerationIncludingGravity: { x: 0.4, y: 0, z: 10.4 },
      rotationRate: null,
      movementState: "running"
    });
  }
  const result = analyzer.snapshot(300, { force: true });
  assert.equal(result.capabilities.rotationAvailable, false);
  assert.equal(result.opening.rotationRms, null);
  assert.equal(result.drift.rotationPercent, null);
});

test("queries exact half-open hip comparison windows without changing the rolling view", () => {
  const analyzer = new HipFormAnalyzer({
    rollingWindowMs: 2_000,
    minimumSampleIntervalMs: 90,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  for (let at = 0; at < 5_000; at += 100) sample(analyzer, at);

  const exact = analyzer.windowMetrics(1_000, 2_000);
  const wider = analyzer.windowMetrics(0, 5_000);
  const visibleRecent = analyzer.snapshot(5_000, { force: true }).recent;
  assert.equal(exact.sampleCount, 10);
  assert.equal(exact.observedBucketCount, 1);
  assert.equal(exact.expectedBucketCount, 1);
  assert.equal(exact.coverageRatio, 1);
  assert.equal(exact.aggregate.kind, "hip");
  assert.equal(exact.aggregate.count, exact.sampleCount);
  assert.equal(wider.sampleCount, 50);
  assert.ok(visibleRecent.sampleCount < wider.sampleCount);
  assert.equal(analyzer.windowMetrics(2_000, 3_000).sampleCount, 10);
  assert.throws(() => analyzer.windowMetrics(1_100, 2_100), /one-second boundaries/);
});

test("retains complete 1, 3, 5, and 10 minute hip windows", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at < 10 * 60_000; at += 100) sample(analyzer, at);
  for (const minutes of [1, 3, 5, 10]) {
    const durationMs = minutes * 60_000;
    const result = analyzer.windowMetrics(10 * 60_000 - durationMs, 10 * 60_000);
    assert.equal(result.durationMs, durationMs);
    assert.equal(result.expectedBucketCount, minutes * 60);
    assert.equal(result.observedBucketCount, minutes * 60);
    assert.equal(result.sampleCount, minutes * 600);
    assert.equal(result.coverageRatio, 1);
  }
});

test("excludes non-running hip samples from comparison windows", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at < 1_000; at += 100) sample(analyzer, at, { running: false });
  for (let at = 1_000; at < 2_000; at += 100) sample(analyzer, at);
  assert.equal(analyzer.windowMetrics(0, 1_000).sampleCount, 0);
  assert.equal(analyzer.windowMetrics(0, 1_000).coverageRatio, 0);
  assert.equal(analyzer.windowMetrics(1_000, 2_000).sampleCount, 10);
});

test("restores compact hip comparison windows at the resumed clock", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at < 5_000; at += 100) sample(analyzer, at);
  const before = analyzer.windowMetrics(0, 4_000);
  const exported = analyzer.exportState();
  assert.ok(Array.isArray(exported.state.comparisonBuckets[0]));
  assert.equal("recentBuckets" in exported.state, false);

  const restored = new HipFormAnalyzer();
  restored.restoreState(exported, 50_000);
  const after = restored.windowMetrics(45_000, 50_000);
  assert.equal(after.sampleCount, before.sampleCount);
  assert.deepEqual(after.metrics, before.metrics);
});

test("drops the rebased open hip bucket after an app resume", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at <= 4_900; at += 100) sample(analyzer, at);
  for (const resumeAtMs of [50_100, 50_950]) {
    const bucketShift = Math.floor((resumeAtMs - 4_900) / 1_000) * 1_000;
    const restored = new HipFormAnalyzer();
    restored.restoreState(analyzer.exportState(), resumeAtMs);
    const currentBucket = Math.floor(resumeAtMs / 1_000) * 1_000;
    assert.equal(restored.windowMetrics(currentBucket, currentBucket + 1_000).sampleCount, 0);
    assert.ok(restored.windowMetrics(bucketShift, bucketShift + 4_000).sampleCount > 0);
  }
});

test("restores the previous hip state format", () => {
  const analyzer = new HipFormAnalyzer({ minimumSampleIntervalMs: 90, summaryIntervalMs: 0 });
  analyzer.start(0);
  for (let at = 0; at < 2_000; at += 100) sample(analyzer, at);
  const current = analyzer.exportState();
  const legacy = {
    ...current,
    version: 2,
    state: {
      ...current.state,
      recentBuckets: analyzer.recentBuckets.map(bucket => ({ atMs: bucket.atMs, stats: { ...bucket.stats } }))
    }
  };
  delete legacy.state.comparisonBuckets;
  const restored = new HipFormAnalyzer();
  const result = restored.restoreState(legacy, 10_000);
  assert.equal(result.opening.sampleCount, 20);
  assert.equal(restored.windowMetrics(8_000, 10_000).sampleCount, 10);
});

test("keeps a simulated hour bounded and fast enough for pocket operation", () => {
  const analyzer = new HipFormAnalyzer();
  analyzer.start(0);
  const started = performance.now();
  for (let at = 0; at <= 60 * 60_000; at += 100) sample(analyzer, at);
  const computeMs = performance.now() - started;
  const stateBytes = Buffer.byteLength(JSON.stringify(analyzer.exportState()));
  assert.ok(computeMs < 5_000, `simulated hour took ${Math.round(computeMs)}ms`);
  assert.ok(stateBytes < 150_000, `saved state grew to ${stateBytes} bytes`);
  assert.ok(analyzer.recentBuckets.length <= 302);
  assert.ok(analyzer.comparisonBuckets.length <= 1_201);
  const lastTwentyMinutes = analyzer.windowMetrics(40 * 60_000, 60 * 60_000);
  assert.equal(lastTwentyMinutes.expectedBucketCount, 1_200);
  assert.equal(lastTwentyMinutes.observedBucketCount, 1_200);
});

test("throttles visible summaries while allowing a forced final snapshot", () => {
  const analyzer = new HipFormAnalyzer({ summaryIntervalMs: 1_000, minimumSampleIntervalMs: 90 });
  analyzer.start(0);
  sample(analyzer, 0);
  const cached = sample(analyzer, 500);
  assert.equal(cached.totalSamples, 0);
  assert.equal(analyzer.snapshot(500, { force: true }).totalSamples, 2);
  sample(analyzer, 1_500);
  assert.equal(analyzer.snapshot(1_500).totalSamples, 3);
});

test("does not count an app-closure gap toward the ten-minute baseline", () => {
  const analyzer = new HipFormAnalyzer({
    openingDurationMs: 1_000,
    minimumBaselineSamples: 2,
    summaryIntervalMs: 0
  });
  analyzer.start(0);
  for (let at = 0; at <= 500; at += 100) sample(analyzer, at);
  const before = analyzer.snapshot(500, { force: true }).runningElapsedMs;
  const restored = new HipFormAnalyzer();
  restored.restoreState(analyzer.exportState(), 5_000);
  sample(restored, 5_100);
  const after = sample(restored, 5_200);
  assert.equal(after.runningElapsedMs, before + 100);
  assert.equal(after.baselineReady, false);
});
