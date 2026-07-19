const MINUTE_MS = 60_000;

export const TECHNIQUE_WINDOW_OPTIONS_MS = Object.freeze([
  MINUTE_MS,
  3 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS
]);

export const DEFAULT_TECHNIQUE_WINDOW_MS = 5 * MINUTE_MS;
export const TECHNIQUE_FRAME_RETENTION_MS = 20 * MINUTE_MS;
export const TECHNIQUE_LAP_STATE_VERSION = 2;

export const RUN_TERRAINS = Object.freeze([
  "unlabelled",
  "flat",
  "uphill",
  "downhill",
  "rolling",
  "trail",
  "treadmill"
]);

const terrainSet = new Set(RUN_TERRAINS);
const allowedPlacements = new Set(["hip", "hand", "unknown"]);
const allowedSides = new Set(["left", "right", "unknown"]);
const allowedMovementStates = new Set(["running", "walking", "stopped", "unknown"]);
const MAX_EXPERIMENTS = 50;
const MAX_CUSTOM_METRICS = 32;
const MIN_PERCENT_BASE = 1e-9;
const MECHANICS_METRIC_KEYS = Object.freeze({
  hip: ["hipVerticalIndex", "hipHorizontalIndex", "hipRotationIndex", "hipImpactVariationIndex"],
  arm: ["armCycleRpm", "armRegularityPercent", "armRangeIndex"]
});
const LEGACY_MECHANICS_METRIC_KEYS = new Set(Object.values(MECHANICS_METRIC_KEYS).flat());

const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const nonNegative = (value, fallback = 0) => {
  const number = finite(value);
  return number === null ? fallback : Math.max(0, number);
};

const round = (value, places = 1) => {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
};

const unique = values => [...new Set(values.filter(value => value != null && value !== ""))];
const uniqueWarnings = warnings => unique(warnings);

const clone = value => {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
};

const stripLegacyMechanicsMetrics = metrics => Object.fromEntries(
  Object.entries(metrics || {}).filter(([key]) => !LEGACY_MECHANICS_METRIC_KEYS.has(key))
);

const stripLegacyMechanicsSummary = summary => {
  if (!summary || typeof summary !== "object") return summary;
  const next = clone(summary);
  next.metrics = stripLegacyMechanicsMetrics(next.metrics);
  next.metricCoveragePercent = stripLegacyMechanicsMetrics(next.metricCoveragePercent);
  next.warnings = uniqueWarnings([...(next.warnings || []), "mechanics-history-upgrading"]);
  return next;
};

const stripLegacyMechanicsComparison = comparison => {
  if (!comparison || typeof comparison !== "object") return comparison;
  const next = clone(comparison);
  next.before = stripLegacyMechanicsSummary(next.before);
  next.after = stripLegacyMechanicsSummary(next.after);
  next.changes = stripLegacyMechanicsMetrics(next.changes);
  next.warnings = uniqueWarnings([...(next.warnings || []), "mechanics-history-upgrading"]);
  next.quality = "low";
  return next;
};

const normaliseWindowMs = value => {
  const number = finite(value);
  if (!TECHNIQUE_WINDOW_OPTIONS_MS.includes(number)) {
    throw new RangeError("Technique Lap window must be 1, 3, 5, or 10 minutes.");
  }
  return number;
};

const normaliseTerrain = value => terrainSet.has(value) ? value : "unlabelled";
const normalisePlacement = value => allowedPlacements.has(value) ? value : "unknown";
const normaliseSide = value => allowedSides.has(value) ? value : "unknown";
const normaliseMovement = value => allowedMovementStates.has(value) ? value : "unknown";

const safeContextText = value => {
  const text = String(value || "unknown").trim().toLowerCase();
  return text ? text.slice(0, 40) : "unknown";
};

const normaliseMetrics = metrics => {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(metrics)) {
    if (entries.length >= MAX_CUSTOM_METRICS) break;
    const key = String(rawKey || "").trim().slice(0, 48);
    const value = finite(rawValue);
    if (key && value !== null) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

const HIP_AGGREGATE_KEYS = Object.freeze([
  "count",
  "verticalSq",
  "horizontalSq",
  "rotationCount",
  "rotationSq",
  "impactSum",
  "impactSq"
]);

const ARM_AGGREGATE_KEYS = Object.freeze([
  "count",
  "intervalCount",
  "intervalSum",
  "intervalSq",
  "positiveIntervalCount",
  "positiveIntervalSum",
  "positiveIntervalSq",
  "negativeIntervalCount",
  "negativeIntervalSum",
  "negativeIntervalSq",
  "rangeCount",
  "rangeSum",
  "rangeSq"
]);

const aggregateKeys = kind => kind === "hip"
  ? HIP_AGGREGATE_KEYS
  : kind === "arm" ? ARM_AGGREGATE_KEYS : null;

const normaliseMechanicsAggregate = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = value.kind === "hip" ? "hip" : value.kind === "arm" ? "arm" : null;
  const keys = aggregateKeys(kind);
  if (!keys) return null;
  return Object.fromEntries([
    ["kind", kind],
    ...keys.map(key => [key, nonNegative(value[key])])
  ]);
};

const encodeMechanicsAggregate = value => {
  const aggregate = normaliseMechanicsAggregate(value);
  if (!aggregate) return null;
  return [aggregate.kind === "hip" ? 1 : 2, ...aggregateKeys(aggregate.kind).map(key => aggregate[key])];
};

const decodeMechanicsAggregate = value => {
  if (!Array.isArray(value)) return normaliseMechanicsAggregate(value);
  const kind = value[0] === 1 ? "hip" : value[0] === 2 ? "arm" : null;
  const keys = aggregateKeys(kind);
  if (!keys) return null;
  return normaliseMechanicsAggregate(Object.fromEntries([
    ["kind", kind],
    ...keys.map((key, index) => [key, value[index + 1]])
  ]));
};

const mergeMechanicsAggregate = (target, source) => {
  const aggregate = normaliseMechanicsAggregate(source);
  if (!aggregate) return target;
  const merged = target || normaliseMechanicsAggregate({ kind: aggregate.kind });
  if (!merged || merged.kind !== aggregate.kind) return target;
  for (const key of aggregateKeys(aggregate.kind)) merged[key] += aggregate[key];
  return merged;
};

const directionalRegularityFromAggregate = aggregate => {
  const directions = ["positive", "negative"]
    .map(prefix => {
      const count = aggregate[`${prefix}IntervalCount`] || 0;
      if (count < 2) return null;
      const mean = aggregate[`${prefix}IntervalSum`] / count;
      const variance = Math.max(0, aggregate[`${prefix}IntervalSq`] / count - mean * mean);
      const coefficientOfVariation = mean ? Math.sqrt(variance) / mean : null;
      const score = coefficientOfVariation === null
        ? null
        : Math.min(1, Math.max(0, 1 - coefficientOfVariation / 0.3));
      return score === null ? null : { count, score };
    })
    .filter(Boolean);
  if (!directions.length) return null;
  const weight = directions.reduce((total, item) => total + item.count, 0);
  return Math.round(directions.reduce((total, item) => total + item.score * item.count, 0) / weight * 100);
};

const metricsFromMechanicsAggregate = aggregate => {
  if (!aggregate?.count) return {};
  if (aggregate.kind === "hip") {
    const impactMean = aggregate.impactSum / aggregate.count;
    const impactVariance = Math.max(0, aggregate.impactSq / aggregate.count - impactMean * impactMean);
    return {
      hipVerticalIndex: round(Math.sqrt(aggregate.verticalSq / aggregate.count), 2),
      hipHorizontalIndex: round(Math.sqrt(aggregate.horizontalSq / aggregate.count), 2),
      hipRotationIndex: aggregate.rotationCount
        ? round(Math.sqrt(aggregate.rotationSq / aggregate.rotationCount), 1)
        : null,
      hipImpactVariationIndex: impactMean
        ? round(Math.sqrt(impactVariance) / impactMean, 3)
        : null
    };
  }
  const positiveMean = aggregate.positiveIntervalCount
    ? aggregate.positiveIntervalSum / aggregate.positiveIntervalCount
    : null;
  const negativeMean = aggregate.negativeIntervalCount
    ? aggregate.negativeIntervalSum / aggregate.negativeIntervalCount
    : null;
  const intervalMean = positiveMean !== null && negativeMean !== null
    ? (positiveMean + negativeMean) / 2
    : aggregate.intervalCount ? aggregate.intervalSum / aggregate.intervalCount : null;
  return {
    armCycleRpm: intervalMean ? round(30_000 / intervalMean, 1) : null,
    armRegularityPercent: directionalRegularityFromAggregate(aggregate),
    armRangeIndex: aggregate.rangeCount ? round(aggregate.rangeSum / aggregate.rangeCount, 3) : null
  };
};

const average = values => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length
  : null;

const metricUnit = key => {
  if (key === "cadenceSpm") return "spm";
  if (key === "rhythmStabilityPercent") return "percentage-points";
  if (key === "heartRateBpm") return "bpm";
  if (key === "speedMps") return "m/s";
  return "index";
};

const metricPlaces = key => {
  if (["cadenceSpm", "rhythmStabilityPercent", "heartRateBpm"].includes(key)) return 1;
  if (key === "speedMps") return 2;
  return 3;
};

function changesBetween(beforeMetrics = {}, afterMetrics = {}) {
  const keys = unique([...Object.keys(beforeMetrics), ...Object.keys(afterMetrics)]).sort();
  const changes = {};
  for (const key of keys) {
    const before = finite(beforeMetrics[key]);
    const after = finite(afterMetrics[key]);
    if (before === null || after === null) continue;
    const absolute = after - before;
    const percent = Math.abs(before) > MIN_PERCENT_BASE ? absolute / Math.abs(before) * 100 : null;
    changes[key] = {
      before: round(before, metricPlaces(key)),
      after: round(after, metricPlaces(key)),
      absolute: round(absolute, metricPlaces(key)),
      percent: percent === null ? null : round(percent, 1),
      direction: Math.abs(absolute) <= MIN_PERCENT_BASE ? "unchanged" : absolute > 0 ? "higher" : "lower",
      unit: metricUnit(key)
    };
  }
  return changes;
}

function qualityFor(warnings, before, after, changes) {
  const hardWarnings = new Set([
    "before-no-running-data",
    "after-no-running-data",
    "placement-mismatch",
    "before-placement-mixed",
    "after-placement-mixed"
  ]);
  if (!Object.keys(changes).length || warnings.some(warning => hardWarnings.has(warning))) return "low";
  if (before.coveragePercent < 50 || after.coveragePercent < 50) return "low";
  return warnings.length ? "moderate" : "high";
}

function contextMismatchWarnings(before, after) {
  const warnings = [];
  const oneValue = (summary, field) => summary.context[field].length === 1 ? summary.context[field][0] : null;

  const beforeTerrain = before.terrain.primary;
  const afterTerrain = after.terrain.primary;
  if (beforeTerrain !== afterTerrain || before.terrain.mixed || after.terrain.mixed) warnings.push("terrain-mismatch");

  const beforePlacement = oneValue(before, "placements");
  const afterPlacement = oneValue(after, "placements");
  if (beforePlacement && afterPlacement && beforePlacement !== afterPlacement) warnings.push("placement-mismatch");

  const beforeSide = oneValue(before, "sides");
  const afterSide = oneValue(after, "sides");
  if (beforeSide && afterSide && beforeSide !== afterSide) warnings.push("side-mismatch");

  const beforeCadenceSource = oneValue(before, "cadenceSources");
  const afterCadenceSource = oneValue(after, "cadenceSources");
  if (beforeCadenceSource && afterCadenceSource && beforeCadenceSource !== afterCadenceSource) {
    warnings.push("cadence-source-mismatch");
  }

  const beforeSpeed = finite(before.metrics.speedMps);
  const afterSpeed = finite(after.metrics.speedMps);
  if (beforeSpeed !== null && afterSpeed !== null) {
    const absolute = Math.abs(afterSpeed - beforeSpeed);
    const relative = beforeSpeed > 0 ? absolute / beforeSpeed : 0;
    if (absolute >= 0.15 && relative >= 0.05) warnings.push("speed-context-changed");
  }

  const beforeHeartRate = finite(before.metrics.heartRateBpm);
  const afterHeartRate = finite(after.metrics.heartRateBpm);
  if (beforeHeartRate !== null && afterHeartRate !== null && Math.abs(afterHeartRate - beforeHeartRate) >= 5) {
    warnings.push("heart-rate-context-changed");
  }
  return warnings;
}

function createComparison({ id, sequence, windowMs, markedAtElapsedMs, before, after, status = "complete", warnings = [] }) {
  const changes = changesBetween(before.metrics, after.metrics);
  const combinedWarnings = uniqueWarnings([
    ...before.warnings.map(warning => `before-${warning}`),
    ...after.warnings.map(warning => `after-${warning}`),
    ...contextMismatchWarnings(before, after),
    ...warnings
  ]);
  return {
    id,
    sequence,
    status,
    windowMs,
    markedAtElapsedMs,
    completedAtElapsedMs: status === "complete" ? markedAtElapsedMs + windowMs : null,
    before,
    after,
    changes,
    warnings: combinedWarnings,
    quality: qualityFor(combinedWarnings, before, after, changes)
  };
}

export class TechniqueLapEngine {
  constructor({ windowMs = DEFAULT_TECHNIQUE_WINDOW_MS, initialTerrain = "unlabelled", maxExperiments = MAX_EXPERIMENTS } = {}) {
    this.windowMs = normaliseWindowMs(windowMs);
    this.maxExperiments = Math.max(1, Math.min(MAX_EXPERIMENTS, Math.floor(nonNegative(maxExperiments, MAX_EXPERIMENTS)) || MAX_EXPERIMENTS));
    this.frames = [];
    this.frameIndexBySecond = new Map();
    this.terrainSegments = [{ id: 1, terrain: normaliseTerrain(initialTerrain), startMs: 0, endMs: null, source: "manual" }];
    this.activeExperiment = null;
    this.experiments = [];
    this.lastElapsedMs = 0;
    this.nextExperimentId = 1;
    this.nextTerrainId = 2;
  }

  setWindowMs(windowMs) {
    const next = normaliseWindowMs(windowMs);
    if (this.activeExperiment) {
      return { changed: false, reason: "comparison-active", windowMs: this.windowMs };
    }
    this.windowMs = next;
    return { changed: true, windowMs: this.windowMs };
  }

  setTerrain(terrain, elapsedMs, { source = "manual" } = {}) {
    const now = this.#advanceTo(elapsedMs);
    const next = normaliseTerrain(terrain);
    const current = this.terrainSegments.at(-1);
    if (current?.terrain === next) return { changed: false, terrain: next, segmentId: current.id };
    if (current) current.endMs = now;
    const segment = {
      id: this.nextTerrainId++,
      terrain: next,
      startMs: now,
      endMs: null,
      source: safeContextText(source)
    };
    this.terrainSegments.push(segment);
    return { changed: true, terrain: next, segmentId: segment.id };
  }

  recordFrame(input = {}) {
    const atMs = this.#advanceTo(input.elapsedMs);
    this.#storeFrame(input, atMs);
    this.#pruneFrames(atMs);
    return this.snapshot(atMs);
  }

  recordClosedFrame(input = {}) {
    const atMs = finite(input.elapsedMs);
    if (atMs === null || atMs < 0) throw new TypeError("Technique Lap requires a non-negative elapsedMs.");
    if (atMs > this.lastElapsedMs) return this.recordFrame(input);
    const oldestRetainedMs = Math.max(0, this.lastElapsedMs - TECHNIQUE_FRAME_RETENTION_MS);
    if (atMs < oldestRetainedMs) throw new RangeError("Closed Technique Lap frame is outside retained history.");
    this.#storeFrame(input, atMs);
    this.#pruneFrames(this.lastElapsedMs);
    return this.snapshot(this.lastElapsedMs);
  }

  #storeFrame({
    movementState = "unknown",
    eligible,
    interrupted = false,
    cadenceSpm = null,
    rhythmStable = null,
    heartRateBpm = null,
    speedMps = null,
    metrics = {},
    mechanicsAggregate = null,
    placement = "unknown",
    side = "unknown",
    cadenceSource = "unknown",
    sensorSource = "unknown"
  }, atMs) {
    const movement = normaliseMovement(movementState);
    const isEligible = movement === "running" && (eligible === undefined || Boolean(eligible));
    const frame = {
      atMs,
      second: Math.floor(atMs / 1_000),
      movement,
      eligible: Boolean(isEligible && !interrupted),
      interrupted: Boolean(interrupted),
      cadenceSpm: finite(cadenceSpm),
      rhythmStable: typeof rhythmStable === "boolean" ? rhythmStable : null,
      heartRateBpm: finite(heartRateBpm),
      speedMps: finite(speedMps),
      metrics: normaliseMetrics(metrics),
      mechanicsAggregate: normaliseMechanicsAggregate(mechanicsAggregate),
      placement: normalisePlacement(placement),
      side: normaliseSide(side),
      cadenceSource: safeContextText(cadenceSource),
      sensorSource: safeContextText(sensorSource)
    };

    const existingIndex = this.frameIndexBySecond.get(frame.second);
    if (existingIndex === undefined) {
      this.frames.push(frame);
      this.frameIndexBySecond.set(frame.second, this.frames.length - 1);
    } else {
      this.frames[existingIndex] = frame;
    }
  }

  tick(elapsedMs) {
    const now = this.#advanceTo(elapsedMs);
    return this.snapshot(now);
  }

  markChange(elapsedMs, { label = "" } = {}) {
    const now = this.#advanceTo(elapsedMs);
    if (this.activeExperiment) {
      return {
        accepted: false,
        reason: "comparison-active",
        remainingMs: Math.max(0, this.activeExperiment.afterEndMs - now),
        active: this.#publicActive(now)
      };
    }
    if (now < this.windowMs) {
      return {
        accepted: false,
        reason: "insufficient-before-time",
        remainingMs: this.windowMs - now
      };
    }

    const id = `technique-${this.nextExperimentId++}`;
    const before = this.summarizeWindow(now - this.windowMs, now);
    this.activeExperiment = {
      id,
      sequence: this.experiments.length + 1,
      label: String(label || "").trim().slice(0, 120),
      windowMs: this.windowMs,
      markedAtElapsedMs: now,
      afterEndMs: now + this.windowMs,
      before
    };
    return { accepted: true, active: this.#publicActive(now) };
  }

  cancelActive(elapsedMs, reason = "cancelled") {
    const now = this.#advanceTo(elapsedMs);
    if (!this.activeExperiment) return null;
    return this.#finishActive(now, "cancelled", safeContextText(reason));
  }

  finishActive(elapsedMs, reason = "run-ended") {
    const activeId = this.activeExperiment?.id || null;
    const now = this.#advanceTo(elapsedMs);
    if (!this.activeExperiment) {
      const completed = activeId ? this.experiments.find(item => item.id === activeId) : null;
      return completed ? clone(completed) : null;
    }
    if (now >= this.activeExperiment.afterEndMs) return this.experiments.at(-1) || null;
    return this.#finishActive(now, "incomplete", safeContextText(reason));
  }

  getTerrainSegments() {
    return clone(this.terrainSegments);
  }

  getCompletedComparisons() {
    return clone(this.experiments);
  }

  summarizeWindow(startMs, endMs) {
    const start = nonNegative(startMs);
    const end = nonNegative(endMs);
    if (end <= start) throw new RangeError("Technique Lap window end must be after its start.");
    const frames = this.frames.filter(frame => frame.atMs >= start && frame.atMs < end);
    const eligibleFrames = frames.filter(frame => frame.eligible);
    const expectedFrames = Math.max(1, Math.ceil((end - start) / 1_000));
    const metricValues = new Map();
    const addMetric = (key, value) => {
      if (!Number.isFinite(value)) return;
      if (!metricValues.has(key)) metricValues.set(key, []);
      metricValues.get(key).push(value);
    };

    let stableCount = 0;
    let stableMeasuredCount = 0;
    const mechanicsByKind = new Map();
    const mechanicsFrameCount = new Map();
    for (const frame of eligibleFrames) {
      addMetric("cadenceSpm", frame.cadenceSpm);
      addMetric("heartRateBpm", frame.heartRateBpm);
      addMetric("speedMps", frame.speedMps);
      if (typeof frame.rhythmStable === "boolean") {
        stableMeasuredCount += 1;
        if (frame.rhythmStable) stableCount += 1;
      }
      for (const [key, value] of Object.entries(frame.metrics)) addMetric(key, value);
      if (frame.mechanicsAggregate?.kind) {
        const kind = frame.mechanicsAggregate.kind;
        mechanicsByKind.set(kind, mergeMechanicsAggregate(mechanicsByKind.get(kind), frame.mechanicsAggregate));
        if (frame.mechanicsAggregate.count > 0) {
          mechanicsFrameCount.set(kind, (mechanicsFrameCount.get(kind) || 0) + 1);
        }
      }
    }

    const metrics = Object.fromEntries(
      [...metricValues.entries()].map(([key, values]) => [key, round(average(values), metricPlaces(key))])
    );
    for (const aggregate of mechanicsByKind.values()) {
      for (const [key, value] of Object.entries(metricsFromMechanicsAggregate(aggregate))) {
        if (Number.isFinite(value)) metrics[key] = value;
      }
    }
    if (stableMeasuredCount) metrics.rhythmStabilityPercent = round(stableCount / stableMeasuredCount * 100, 1);

    const terrain = this.#terrainContext(start, end);
    const contextFrames = eligibleFrames.length ? eligibleFrames : frames;
    const context = {
      placements: unique(contextFrames.map(frame => frame.placement).filter(value => value !== "unknown")),
      sides: unique(contextFrames.map(frame => frame.side).filter(value => value !== "unknown")),
      cadenceSources: unique(contextFrames.map(frame => frame.cadenceSource).filter(value => value !== "unknown")),
      sensorSources: unique(contextFrames.map(frame => frame.sensorSource).filter(value => value !== "unknown"))
    };
    const coveragePercent = Math.min(100, Math.round(eligibleFrames.length / expectedFrames * 100));
    const sampleCoveragePercent = Math.min(100, Math.round(frames.length / expectedFrames * 100));
    const warnings = [];
    if (!eligibleFrames.length) warnings.push("no-running-data");
    if (coveragePercent < 80) warnings.push("low-running-coverage");
    if (sampleCoveragePercent < 100) warnings.push("missing-samples");
    if (frames.some(frame => !frame.eligible && ["walking", "stopped"].includes(frame.movement))) warnings.push("non-running-time");
    if (frames.some(frame => frame.interrupted)) warnings.push("interrupted-samples");
    if (terrain.unlabelled) warnings.push("terrain-unlabelled");
    if (terrain.mixed) warnings.push("terrain-mixed");
    if (terrain.variable) warnings.push("variable-terrain");
    if (context.placements.length > 1) warnings.push("placement-mixed");
    if (context.sides.length > 1) warnings.push("side-mixed");
    if (context.cadenceSources.length > 1) warnings.push("cadence-source-mixed");
    if (context.sensorSources.length > 1) warnings.push("sensor-source-mixed");

    const metricCoveragePercent = Object.fromEntries(
      [...metricValues.entries()].map(([key, values]) => [key, Math.min(100, Math.round(values.length / expectedFrames * 100))])
    );
    for (const [kind, frameCount] of mechanicsFrameCount.entries()) {
      const coverage = Math.min(100, Math.round(frameCount / expectedFrames * 100));
      for (const key of MECHANICS_METRIC_KEYS[kind] || []) {
        if (!Number.isFinite(metrics[key])) continue;
        metricCoveragePercent[key] = coverage;
        if (coverage < 80) delete metrics[key];
      }
      if (coverage < 80) warnings.push("mechanics-history-upgrading");
    }
    if (stableMeasuredCount) metricCoveragePercent.rhythmStabilityPercent = Math.min(100, Math.round(stableMeasuredCount / expectedFrames * 100));

    return {
      startMs: start,
      endMs: end,
      durationMs: end - start,
      expectedFrames,
      observedFrames: frames.length,
      eligibleFrames: eligibleFrames.length,
      coveragePercent,
      sampleCoveragePercent,
      metricCoveragePercent,
      metrics,
      terrain,
      context,
      warnings: uniqueWarnings(warnings)
    };
  }

  compareLastToPrevious({ elapsedMs = this.lastElapsedMs, windowMs = this.windowMs } = {}) {
    const duration = normaliseWindowMs(windowMs);
    const now = this.#advanceTo(elapsedMs);
    if (now < duration * 2) {
      return { available: false, reason: "insufficient-history", remainingMs: duration * 2 - now };
    }
    const previous = this.summarizeWindow(now - duration * 2, now - duration);
    const last = this.summarizeWindow(now - duration, now);
    const comparison = createComparison({
      id: "retrospective",
      sequence: 0,
      windowMs: duration,
      markedAtElapsedMs: now - duration,
      before: previous,
      after: last
    });
    return { available: true, previous, last, changes: comparison.changes, warnings: comparison.warnings, quality: comparison.quality };
  }

  snapshot(elapsedMs = this.lastElapsedMs) {
    const now = nonNegative(elapsedMs, this.lastElapsedMs);
    return {
      windowMs: this.windowMs,
      elapsedMs: now,
      active: this.#publicActive(now),
      completedCount: this.experiments.filter(item => item.status === "complete").length,
      experiments: clone(this.experiments),
      currentTerrain: this.terrainSegments.at(-1)?.terrain || "unlabelled",
      frameCount: this.frames.length
    };
  }

  exportState() {
    return {
      version: TECHNIQUE_LAP_STATE_VERSION,
      windowMs: this.windowMs,
      maxExperiments: this.maxExperiments,
      lastElapsedMs: this.lastElapsedMs,
      nextExperimentId: this.nextExperimentId,
      nextTerrainId: this.nextTerrainId,
      terrainSegments: clone(this.terrainSegments),
      frames: this.frames.map(frame => [
        frame.atMs,
        frame.movement,
        frame.eligible ? 1 : 0,
        frame.interrupted ? 1 : 0,
        frame.cadenceSpm,
        frame.rhythmStable === null ? null : frame.rhythmStable ? 1 : 0,
        frame.heartRateBpm,
        frame.speedMps,
        frame.metrics,
        frame.placement,
        frame.side,
        frame.cadenceSource,
        frame.sensorSource,
        encodeMechanicsAggregate(frame.mechanicsAggregate)
      ]),
      activeExperiment: clone(this.activeExperiment),
      experiments: clone(this.experiments)
    };
  }

  static restore(payload, { elapsedMs = null } = {}) {
    if (!payload || ![1, TECHNIQUE_LAP_STATE_VERSION].includes(payload.version)) {
      throw new TypeError("Unsupported Technique Lap state.");
    }
    const legacyMechanics = payload.version === 1;
    const engine = new TechniqueLapEngine({
      windowMs: payload.windowMs,
      initialTerrain: payload.terrainSegments?.[0]?.terrain,
      maxExperiments: payload.maxExperiments
    });
    engine.lastElapsedMs = nonNegative(payload.lastElapsedMs);
    engine.nextExperimentId = Math.max(1, Math.floor(nonNegative(payload.nextExperimentId, 1)));
    engine.nextTerrainId = Math.max(2, Math.floor(nonNegative(payload.nextTerrainId, 2)));
    engine.terrainSegments = TechniqueLapEngine.#restoreTerrainSegments(payload.terrainSegments);
    engine.frames = TechniqueLapEngine.#restoreFrames(payload.frames, { legacyMechanics });
    engine.activeExperiment = !legacyMechanics && payload.activeExperiment && typeof payload.activeExperiment === "object"
      ? clone(payload.activeExperiment)
      : null;
    engine.experiments = Array.isArray(payload.experiments)
      ? clone(payload.experiments.slice(-engine.maxExperiments)).map(comparison => (
          legacyMechanics ? stripLegacyMechanicsComparison(comparison) : comparison
        ))
      : [];
    engine.#rebuildFrameIndex();
    const restoredAt = finite(elapsedMs);
    if (restoredAt !== null) engine.#advanceTo(restoredAt);
    else engine.#pruneFrames(engine.lastElapsedMs);
    return engine;
  }

  static #restoreTerrainSegments(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      return [{ id: 1, terrain: "unlabelled", startMs: 0, endMs: null, source: "manual" }];
    }
    return segments.map((segment, index) => ({
      id: Math.max(1, Math.floor(nonNegative(segment?.id, index + 1))),
      terrain: normaliseTerrain(segment?.terrain),
      startMs: nonNegative(segment?.startMs),
      endMs: finite(segment?.endMs) === null ? null : nonNegative(segment.endMs),
      source: safeContextText(segment?.source)
    })).sort((left, right) => left.startMs - right.startMs);
  }

  static #restoreFrames(frames, { legacyMechanics = false } = {}) {
    if (!Array.isArray(frames)) return [];
    const restored = [];
    for (const packed of frames) {
      if (!Array.isArray(packed)) continue;
      const atMs = finite(packed[0]);
      if (atMs === null || atMs < 0) continue;
      restored.push({
        atMs,
        second: Math.floor(atMs / 1_000),
        movement: normaliseMovement(packed[1]),
        eligible: packed[2] === 1,
        interrupted: packed[3] === 1,
        cadenceSpm: finite(packed[4]),
        rhythmStable: packed[5] === null ? null : packed[5] === 1,
        heartRateBpm: finite(packed[6]),
        speedMps: finite(packed[7]),
        metrics: legacyMechanics
          ? stripLegacyMechanicsMetrics(normaliseMetrics(packed[8]))
          : normaliseMetrics(packed[8]),
        placement: normalisePlacement(packed[9]),
        side: normaliseSide(packed[10]),
        cadenceSource: safeContextText(packed[11]),
        sensorSource: safeContextText(packed[12]),
        mechanicsAggregate: legacyMechanics ? null : decodeMechanicsAggregate(packed[13])
      });
    }
    return restored.sort((left, right) => left.atMs - right.atMs);
  }

  #advanceTo(elapsedMs) {
    const now = finite(elapsedMs);
    if (now === null || now < 0) throw new TypeError("Technique Lap requires a non-negative elapsedMs.");
    if (now < this.lastElapsedMs) throw new RangeError("Technique Lap elapsedMs must not move backwards.");
    this.lastElapsedMs = now;
    if (this.activeExperiment && now >= this.activeExperiment.afterEndMs) {
      this.#finishActive(this.activeExperiment.afterEndMs, "complete");
    }
    this.#pruneFrames(now);
    return now;
  }

  #finishActive(observedAtMs, status, reason = "") {
    const active = this.activeExperiment;
    if (!active) return null;
    const after = this.summarizeWindow(active.markedAtElapsedMs, active.afterEndMs);
    const extraWarnings = [];
    if (status !== "complete") extraWarnings.push("after-window-incomplete");
    if (reason) extraWarnings.push(reason);
    const comparison = createComparison({
      id: active.id,
      sequence: active.sequence,
      windowMs: active.windowMs,
      markedAtElapsedMs: active.markedAtElapsedMs,
      before: active.before,
      after,
      status,
      warnings: extraWarnings
    });
    comparison.label = active.label;
    comparison.observedThroughElapsedMs = observedAtMs;
    this.experiments.push(comparison);
    this.experiments = this.experiments.slice(-this.maxExperiments);
    this.activeExperiment = null;
    return clone(comparison);
  }

  #publicActive(now) {
    if (!this.activeExperiment) return null;
    return {
      id: this.activeExperiment.id,
      sequence: this.activeExperiment.sequence,
      label: this.activeExperiment.label,
      windowMs: this.activeExperiment.windowMs,
      markedAtElapsedMs: this.activeExperiment.markedAtElapsedMs,
      afterEndMs: this.activeExperiment.afterEndMs,
      remainingMs: Math.max(0, this.activeExperiment.afterEndMs - now),
      before: clone(this.activeExperiment.before)
    };
  }

  #terrainContext(startMs, endMs) {
    const overlaps = [];
    for (const segment of this.terrainSegments) {
      const segmentEnd = segment.endMs ?? Math.max(this.lastElapsedMs, endMs);
      const overlapStart = Math.max(startMs, segment.startMs);
      const overlapEnd = Math.min(endMs, segmentEnd);
      if (overlapEnd > overlapStart) {
        overlaps.push({ terrain: segment.terrain, durationMs: overlapEnd - overlapStart, segmentId: segment.id });
      }
    }
    if (!overlaps.length) overlaps.push({ terrain: "unlabelled", durationMs: endMs - startMs, segmentId: null });
    const durations = {};
    for (const overlap of overlaps) durations[overlap.terrain] = (durations[overlap.terrain] || 0) + overlap.durationMs;
    const terrains = Object.keys(durations);
    const primary = terrains.sort((left, right) => durations[right] - durations[left])[0] || "unlabelled";
    return {
      primary,
      terrains,
      durationsMs: durations,
      mixed: terrains.length > 1,
      unlabelled: terrains.includes("unlabelled"),
      variable: terrains.some(terrain => ["rolling", "trail"].includes(terrain)),
      segmentIds: unique(overlaps.map(overlap => overlap.segmentId))
    };
  }

  #pruneFrames(now) {
    const oldest = Math.max(0, now - TECHNIQUE_FRAME_RETENTION_MS);
    if (this.frames.length && this.frames[0].atMs < oldest) {
      this.frames = this.frames.filter(frame => frame.atMs >= oldest);
      this.#rebuildFrameIndex();
    }
  }

  #rebuildFrameIndex() {
    this.frames.sort((left, right) => left.atMs - right.atMs);
    this.frameIndexBySecond = new Map(this.frames.map((frame, index) => [frame.second, index]));
  }
}
