import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TECHNIQUE_WINDOW_MS,
  RUN_TERRAINS,
  TECHNIQUE_FRAME_RETENTION_MS,
  TECHNIQUE_WINDOW_OPTIONS_MS,
  TechniqueLapEngine
} from "../src/running/technique-lap-engine.js";
import { ArmSwingAnalyzer } from "../src/running/arm-swing-analyzer.js";
import { HipFormAnalyzer } from "../src/running/hip-form-analyzer.js";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

test("merges arm aggregate statistics before deriving whole-window regularity", () => {
  const analyzer = new ArmSwingAnalyzer();
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  analyzer.start(0);
  for (let second = 0; second < 60; second += 1) {
    const intervalMs = second % 2 ? 300 : 500;
    for (const [offset, direction] of [[100, 1], [400, -1], [700, 1]]) {
      analyzer.addComparisonSwing({
        atMs: second * SECOND_MS + offset,
        intervalMs,
        rangeValue: 20,
        direction
      });
    }
    const aggregate = analyzer.windowMetrics(second * SECOND_MS, (second + 1) * SECOND_MS).aggregate;
    engine.recordFrame({
      elapsedMs: second * SECOND_MS,
      movementState: "running",
      eligible: true,
      mechanicsAggregate: aggregate,
      placement: "hand"
    });
  }
  const exact = analyzer.windowMetrics(0, MINUTE_MS).metrics;
  const summary = engine.summarizeWindow(0, MINUTE_MS);
  assert.equal(exact.regularityPercent, 17);
  assert.equal(summary.metrics.armRegularityPercent, exact.regularityPercent);
  assert.equal(summary.metrics.armCycleRpm, exact.armCycleRpm);
  assert.equal(summary.metrics.armRangeIndex, exact.rangeMean);
  const exported = engine.exportState();
  assert.ok(Array.isArray(exported.frames[0][13]));
  const restored = TechniqueLapEngine.restore(exported);
  assert.deepEqual(restored.summarizeWindow(0, MINUTE_MS).metrics, summary.metrics);
});

test("merges hip aggregate statistics before deriving RMS and impact variation", () => {
  const analyzer = new HipFormAnalyzer();
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  analyzer.start(0);
  for (let second = 0; second < 60; second += 1) {
    const value = second % 2 ? 2 : 1;
    for (let sample = 0; sample < 10; sample += 1) {
      analyzer.addRecentMeasurement(second * SECOND_MS + sample * 100, {
        vertical: value,
        horizontal: value / 2,
        rotation: 10,
        impact: value
      });
    }
    const aggregate = analyzer.windowMetrics(second * SECOND_MS, (second + 1) * SECOND_MS).aggregate;
    engine.recordFrame({
      elapsedMs: second * SECOND_MS,
      movementState: "running",
      eligible: true,
      mechanicsAggregate: aggregate,
      placement: "hip"
    });
  }
  const exact = analyzer.windowMetrics(0, MINUTE_MS).metrics;
  const summary = engine.summarizeWindow(0, MINUTE_MS);
  assert.equal(exact.verticalRms, 1.58);
  assert.equal(exact.impactVariation, 0.333);
  assert.equal(summary.metrics.hipVerticalIndex, exact.verticalRms);
  assert.equal(summary.metrics.hipHorizontalIndex, exact.horizontalRms);
  assert.equal(summary.metrics.hipRotationIndex, exact.rotationRms);
  assert.equal(summary.metrics.hipImpactVariationIndex, exact.impactVariation);
});

test("accepts a closed bucket after the visible clock has advanced", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  engine.tick(2_000);
  engine.recordClosedFrame({
    elapsedMs: 1_000,
    movementState: "running",
    eligible: true,
    cadenceSpm: 172
  });
  assert.equal(engine.summarizeWindow(1_000, 2_000).metrics.cadenceSpm, 172);
  assert.equal(engine.snapshot().elapsedMs, 2_000);
});

test("restores legacy frames that predate mechanics aggregates", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  recordRunning(engine, 0, 172, { metrics: { hipVerticalIndex: 1, motionIndex: 1.72 } });
  const legacy = engine.exportState();
  legacy.version = 1;
  legacy.frames = legacy.frames.map(frame => frame.slice(0, 13));
  const restored = TechniqueLapEngine.restore(legacy);
  const summary = restored.summarizeWindow(0, 1_000);
  assert.equal(summary.metrics.cadenceSpm, 172);
  assert.equal(summary.metrics.motionIndex, 1.72);
  assert.equal(summary.metrics.hipVerticalIndex, undefined);
});

test("does not claim mechanics until a mixed legacy window has fresh aggregate coverage", () => {
  const original = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  for (let second = 0; second < 60; second += 1) {
    recordRunning(original, second * SECOND_MS, 170, { metrics: { hipVerticalIndex: 1 } });
  }
  const legacy = original.exportState();
  legacy.version = 1;
  legacy.frames = legacy.frames.map(frame => frame.slice(0, 13));
  const restored = TechniqueLapEngine.restore(legacy);
  for (let second = 60; second < 120; second += 1) {
    restored.recordFrame({
      elapsedMs: second * SECOND_MS,
      movementState: "running",
      eligible: true,
      mechanicsAggregate: {
        kind: "hip",
        count: 10,
        verticalSq: 40,
        horizontalSq: 10,
        rotationCount: 10,
        rotationSq: 1_000,
        impactSum: 20,
        impactSq: 40
      }
    });
  }
  const mixed = restored.summarizeWindow(0, 120 * SECOND_MS);
  assert.equal(mixed.coveragePercent, 100);
  assert.equal(mixed.metricCoveragePercent.hipVerticalIndex, 50);
  assert.equal(mixed.metrics.hipVerticalIndex, undefined);
  assert.ok(mixed.warnings.includes("mechanics-history-upgrading"));
});

function recordRunning(engine, elapsedMs, cadenceSpm, options = {}) {
  return engine.recordFrame({
    elapsedMs,
    movementState: "running",
    cadenceSpm,
    rhythmStable: options.rhythmStable ?? true,
    heartRateBpm: options.heartRateBpm ?? 145,
    speedMps: options.speedMps ?? 3,
    placement: options.placement ?? "hip",
    side: options.side ?? "right",
    cadenceSource: options.cadenceSource ?? "garmin",
    sensorSource: options.sensorSource ?? "phone-motion",
    metrics: options.metrics ?? { motionIndex: cadenceSpm / 100 }
  });
}

function fillRunning(engine, startMs, endMs, cadenceSpm, options = {}) {
  for (let atMs = startMs; atMs < endMs; atMs += SECOND_MS) {
    recordRunning(engine, atMs, cadenceSpm, options);
  }
}

test("supports only the fixed 1, 3, 5 and 10 minute windows and defaults to five", () => {
  assert.deepEqual(TECHNIQUE_WINDOW_OPTIONS_MS, [1, 3, 5, 10].map(minutes => minutes * MINUTE_MS));
  assert.equal(DEFAULT_TECHNIQUE_WINDOW_MS, 5 * MINUTE_MS);
  assert.equal(new TechniqueLapEngine().snapshot().windowMs, 5 * MINUTE_MS);
  assert.throws(() => new TechniqueLapEngine({ windowMs: 2 * MINUTE_MS }), /1, 3, 5, or 10/);

  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  assert.deepEqual(engine.setWindowMs(3 * MINUTE_MS), { changed: true, windowMs: 3 * MINUTE_MS });
});

test("uses exact half-open BEFORE and AFTER boundaries without making a ten-minute average", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160, { rhythmStable: false });

  const marked = engine.markChange(MINUTE_MS);
  assert.equal(marked.accepted, true);
  assert.equal(marked.active.before.startMs, 0);
  assert.equal(marked.active.before.endMs, MINUTE_MS);
  assert.equal(marked.active.before.metrics.cadenceSpm, 160);

  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 170, { rhythmStable: true });
  recordRunning(engine, 2 * MINUTE_MS, 999);

  const result = engine.snapshot().experiments[0];
  assert.equal(result.status, "complete");
  assert.deepEqual([result.before.startMs, result.before.endMs], [0, MINUTE_MS]);
  assert.deepEqual([result.after.startMs, result.after.endMs], [MINUTE_MS, 2 * MINUTE_MS]);
  assert.equal(result.before.metrics.cadenceSpm, 160);
  assert.equal(result.after.metrics.cadenceSpm, 170);
  assert.equal(result.changes.cadenceSpm.absolute, 10);
  assert.equal(result.changes.cadenceSpm.direction, "higher");
  assert.equal(result.before.metrics.rhythmStabilityPercent, 0);
  assert.equal(result.after.metrics.rhythmStabilityPercent, 100);
});

test("requires a complete elapsed before range and permits only one active experiment", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  const early = engine.markChange(45_000);
  assert.deepEqual(early, {
    accepted: false,
    reason: "insufficient-before-time",
    remainingMs: 15_000
  });

  fillRunning(engine, 45_000, MINUTE_MS, 160);
  assert.equal(engine.markChange(MINUTE_MS).accepted, true);
  assert.equal(engine.setWindowMs(3 * MINUTE_MS).reason, "comparison-active");
  const overlapping = engine.markChange(61_000);
  assert.equal(overlapping.accepted, false);
  assert.equal(overlapping.reason, "comparison-active");
  assert.equal(overlapping.remainingMs, 59_000);
});

test("allows sequential A to B and B to C experiments without merging their windows", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS, { label: "A to B" });
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 170);

  const secondMark = engine.markChange(2 * MINUTE_MS, { label: "B to C" });
  assert.equal(secondMark.accepted, true);
  assert.equal(secondMark.active.before.metrics.cadenceSpm, 170);
  fillRunning(engine, 2 * MINUTE_MS, 3 * MINUTE_MS, 175);
  engine.tick(3 * MINUTE_MS);

  const [first, second] = engine.snapshot().experiments;
  assert.equal(first.label, "A to B");
  assert.equal(first.before.metrics.cadenceSpm, 160);
  assert.equal(first.after.metrics.cadenceSpm, 170);
  assert.equal(second.label, "B to C");
  assert.equal(second.before.metrics.cadenceSpm, 170);
  assert.equal(second.after.metrics.cadenceSpm, 175);
});

test("keeps walks, stops and missing seconds inside the fixed AFTER boundary", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 90_000, 170);
  for (let atMs = 90_000; atMs < 100_000; atMs += SECOND_MS) {
    engine.recordFrame({ elapsedMs: atMs, movementState: "walking", eligible: true, cadenceSpm: 999, placement: "hip", side: "right" });
  }
  for (let atMs = 100_000; atMs < 110_000; atMs += SECOND_MS) {
    engine.recordFrame({ elapsedMs: atMs, movementState: "stopped", cadenceSpm: 999, placement: "hip", side: "right" });
  }
  engine.tick(2 * MINUTE_MS);

  const result = engine.snapshot().experiments[0];
  assert.equal(result.after.endMs, 2 * MINUTE_MS);
  assert.equal(result.after.metrics.cadenceSpm, 170);
  assert.equal(result.after.observedFrames, 50);
  assert.equal(result.after.eligibleFrames, 30);
  assert.equal(result.after.coveragePercent, 50);
  assert.ok(result.warnings.includes("after-non-running-time"));
  assert.ok(result.warnings.includes("after-missing-samples"));
  assert.ok(result.warnings.includes("after-low-running-coverage"));
});

test("records manual terrain segments and warns when terrain changes across a comparison", () => {
  assert.deepEqual(RUN_TERRAINS, ["unlabelled", "flat", "uphill", "downhill", "rolling", "trail", "treadmill"]);
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS);
  const changed = engine.setTerrain("uphill", MINUTE_MS, { source: "voice" });
  assert.equal(changed.changed, true);
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 165);
  engine.tick(2 * MINUTE_MS);

  const result = engine.snapshot().experiments[0];
  assert.equal(result.before.terrain.primary, "flat");
  assert.equal(result.after.terrain.primary, "uphill");
  assert.ok(result.warnings.includes("terrain-mismatch"));
  assert.equal(result.quality, "moderate");
  assert.deepEqual(engine.getTerrainSegments().map(segment => segment.terrain), ["flat", "uphill"]);

  engine.setTerrain("rolling", 2 * MINUTE_MS);
  fillRunning(engine, 2 * MINUTE_MS, 3 * MINUTE_MS, 165);
  const rolling = engine.summarizeWindow(2 * MINUTE_MS, 3 * MINUTE_MS);
  assert.equal(rolling.terrain.variable, true);
  assert.ok(rolling.warnings.includes("variable-terrain"));
});

test("keeps unlabelled terrain honest instead of assuming flat", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  fillRunning(engine, 0, MINUTE_MS, 160);
  const summary = engine.summarizeWindow(0, MINUTE_MS);
  assert.equal(summary.terrain.primary, "unlabelled");
  assert.ok(summary.warnings.includes("terrain-unlabelled"));
});

test("reports placement, side, cadence-source, pace and heart-rate context warnings", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160, { heartRateBpm: 140, speedMps: 3, placement: "hip", side: "right", cadenceSource: "phone" });
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 170, { heartRateBpm: 150, speedMps: 3.3, placement: "hand", side: "left", cadenceSource: "garmin" });
  engine.tick(2 * MINUTE_MS);

  const result = engine.snapshot().experiments[0];
  for (const warning of ["placement-mismatch", "side-mismatch", "cadence-source-mismatch", "speed-context-changed", "heart-rate-context-changed"]) {
    assert.ok(result.warnings.includes(warning), `missing ${warning}`);
  }
  assert.equal(result.quality, "low");
});

test("compares retrospective last and previous fixed windows without creating an experiment", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "treadmill" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 168);
  engine.tick(2 * MINUTE_MS);

  const result = engine.compareLastToPrevious({ elapsedMs: 2 * MINUTE_MS, windowMs: MINUTE_MS });
  assert.equal(result.available, true);
  assert.equal(result.previous.metrics.cadenceSpm, 160);
  assert.equal(result.last.metrics.cadenceSpm, 168);
  assert.equal(result.changes.cadenceSpm.absolute, 8);
  assert.equal(engine.snapshot().experiments.length, 0);

  assert.deepEqual(new TechniqueLapEngine({ windowMs: MINUTE_MS }).compareLastToPrevious({ elapsedMs: 90_000 }), {
    available: false,
    reason: "insufficient-history",
    remainingMs: 30_000
  });
});

test("exports and restores an unfinished comparison with its exact remaining time", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "trail" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS, { label: "shorter steps" });
  fillRunning(engine, MINUTE_MS, 90_000, 166);

  const restored = TechniqueLapEngine.restore(engine.exportState(), { elapsedMs: 90_000 });
  assert.equal(restored.snapshot().active.remainingMs, 30_000);
  assert.equal(restored.snapshot().active.before.metrics.cadenceSpm, 160);
  fillRunning(restored, 90_000, 2 * MINUTE_MS, 166);
  restored.tick(2 * MINUTE_MS);

  const result = restored.snapshot().experiments[0];
  assert.equal(result.status, "complete");
  assert.equal(result.label, "shorter steps");
  assert.equal(result.after.metrics.cadenceSpm, 166);
  assert.equal(restored.snapshot().currentTerrain, "trail");
});

test("restoring after the deadline finalizes at the original boundary and counts offline time as missing", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 90_000, 166);

  const restored = TechniqueLapEngine.restore(engine.exportState(), { elapsedMs: 130_000 });
  const result = restored.snapshot().experiments[0];
  assert.equal(restored.snapshot().active, null);
  assert.equal(result.status, "complete");
  assert.equal(result.after.endMs, 2 * MINUTE_MS);
  assert.equal(result.after.coveragePercent, 50);
  assert.ok(result.warnings.includes("after-missing-samples"));
});

test("finishing early retains the full planned AFTER range and marks it incomplete", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 90_000, 165);

  const result = engine.finishActive(90_000, "run-ended");
  assert.equal(result.status, "incomplete");
  assert.equal(result.after.startMs, MINUTE_MS);
  assert.equal(result.after.endMs, 2 * MINUTE_MS);
  assert.equal(result.observedThroughElapsedMs, 90_000);
  assert.ok(result.warnings.includes("after-window-incomplete"));
  assert.ok(result.warnings.includes("run-ended"));
});

test("finishing at the deadline returns the completed summary", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160);
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 165);
  const result = engine.finishActive(2 * MINUTE_MS);
  assert.equal(result.status, "complete");
  assert.equal(engine.getCompletedComparisons().length, 1);
});

test("retains at most the latest twenty minutes of compact one-second frames", () => {
  const engine = new TechniqueLapEngine({ windowMs: 10 * MINUTE_MS, initialTerrain: "flat" });
  for (let second = 0; second <= 60 * 60; second += 1) {
    recordRunning(engine, second * SECOND_MS, 165, { metrics: { motionIndex: 1.25 } });
  }
  const state = engine.exportState();
  assert.equal(TECHNIQUE_FRAME_RETENTION_MS, 20 * MINUTE_MS);
  assert.ok(state.frames.length <= TECHNIQUE_FRAME_RETENTION_MS / SECOND_MS + 1);
  assert.ok(state.frames[0][0] >= 40 * MINUTE_MS);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 400_000);
});

test("custom mechanic indexes are reported only as neutral higher, lower or unchanged changes", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS, initialTerrain: "flat" });
  fillRunning(engine, 0, MINUTE_MS, 160, { metrics: { verticalMotionIndex: 1.2, impactVariationIndex: 0 } });
  engine.markChange(MINUTE_MS);
  fillRunning(engine, MINUTE_MS, 2 * MINUTE_MS, 160, { metrics: { verticalMotionIndex: 1, impactVariationIndex: 0.2 } });
  engine.tick(2 * MINUTE_MS);

  const result = engine.snapshot().experiments[0];
  assert.equal(result.changes.verticalMotionIndex.direction, "lower");
  assert.equal(result.changes.impactVariationIndex.direction, "higher");
  assert.equal(result.changes.impactVariationIndex.percent, null);
  assert.doesNotMatch(JSON.stringify(result), /better|worse/i);
});

test("rejects backwards elapsed time and unsupported saved states", () => {
  const engine = new TechniqueLapEngine({ windowMs: MINUTE_MS });
  engine.tick(10_000);
  assert.throws(() => engine.tick(9_999), /must not move backwards/);
  assert.throws(() => TechniqueLapEngine.restore({ version: 999 }), /Unsupported Technique Lap state/);
});
