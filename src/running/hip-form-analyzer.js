const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value, places = 2) => value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

const emptyStats = () => ({
  count: 0,
  verticalSq: 0,
  horizontalSq: 0,
  rotationCount: 0,
  rotationSq: 0,
  impactSum: 0,
  impactSq: 0
});

const addMeasurement = (stats, { vertical, horizontal, rotation, impact }) => {
  stats.count += 1;
  stats.verticalSq += vertical * vertical;
  stats.horizontalSq += horizontal * horizontal;
  if (rotation !== null) {
    stats.rotationCount += 1;
    stats.rotationSq += rotation * rotation;
  }
  stats.impactSum += impact;
  stats.impactSq += impact * impact;
};

const mergeStats = (target, source) => {
  for (const key of Object.keys(target)) target[key] += finite(source?.[key]) ?? 0;
  return target;
};

export const DEFAULT_FORM_CONFIG = Object.freeze({
  openingDurationMs: 10 * 60_000,
  middleEndMs: 40 * 60_000,
  rollingWindowMs: 5 * 60_000,
  minimumBaselineSamples: 3_000,
  expectedSampleRateHz: 10,
  minimumSampleIntervalMs: 90,
  maximumRunningIntervalMs: 250,
  summaryIntervalMs: 1_000,
  orientationDotThreshold: 0.8,
  orientationMismatchRatio: 0.05
});

export class HipFormAnalyzer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_FORM_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.startedAtMs = null;
    this.lastSampleAtMs = null;
    this.lastMovementState = "unknown";
    this.gravity = null;
    this.referenceGravity = null;
    this.totalSamples = 0;
    this.runningSamples = 0;
    this.runningElapsedMs = 0;
    this.sampleGapCount = 0;
    this.orientationSamples = 0;
    this.orientationMismatchCount = 0;
    this.segmentStats = { opening: emptyStats(), middle: emptyStats(), late: emptyStats() };
    this.recentBuckets = [];
    this.lastSnapshotAtMs = -Infinity;
    this.cachedSnapshot = null;
  }

  start(timestampMs = 0) {
    this.reset();
    this.startedAtMs = finite(timestampMs) ?? 0;
    return this.snapshot(this.startedAtMs, { force: true });
  }

  update({ timestampMs, accelerationIncludingGravity, rotationRate = null, movementState = "unknown" } = {}) {
    const now = finite(timestampMs);
    const vector = accelerationIncludingGravity;
    const x = finite(vector?.x);
    const y = finite(vector?.y);
    const z = finite(vector?.z);
    if (now === null || x === null || y === null || z === null) return this.snapshot(now ?? this.lastSampleAtMs ?? 0);
    if (this.startedAtMs === null) this.start(now);
    if (this.lastSampleAtMs !== null && now - this.lastSampleAtMs < this.config.minimumSampleIntervalMs) return this.snapshot(now);

    const intervalMs = this.lastSampleAtMs === null ? 0 : Math.max(0, now - this.lastSampleAtMs);
    if (intervalMs > this.config.maximumRunningIntervalMs) this.sampleGapCount += 1;
    this.lastSampleAtMs = now;
    this.totalSamples += 1;

    this.gravity ??= { x, y, z };
    const alpha = 0.035;
    this.gravity.x = this.gravity.x * (1 - alpha) + x * alpha;
    this.gravity.y = this.gravity.y * (1 - alpha) + y * alpha;
    this.gravity.z = this.gravity.z * (1 - alpha) + z * alpha;
    const gravityMagnitude = Math.hypot(this.gravity.x, this.gravity.y, this.gravity.z) || 1;
    const unitGravity = {
      x: this.gravity.x / gravityMagnitude,
      y: this.gravity.y / gravityMagnitude,
      z: this.gravity.z / gravityMagnitude
    };
    const dx = x - this.gravity.x;
    const dy = y - this.gravity.y;
    const dz = z - this.gravity.z;
    const total = Math.hypot(dx, dy, dz);
    const vertical = Math.abs(dx * unitGravity.x + dy * unitGravity.y + dz * unitGravity.z);
    const horizontal = Math.sqrt(Math.max(0, total * total - vertical * vertical));
    const rotationParts = [rotationRate?.alpha, rotationRate?.beta, rotationRate?.gamma].map(finite);
    const rotation = rotationParts.some(value => value !== null)
      ? Math.hypot(...rotationParts.map(value => value ?? 0))
      : null;

    if (movementState === "running") {
      if (this.lastMovementState === "running" && intervalMs <= this.config.maximumRunningIntervalMs) {
        this.runningElapsedMs += intervalMs;
      }
      this.runningSamples += 1;
      const measurement = { vertical, horizontal, rotation, impact: total };
      const openingIncomplete = this.runningElapsedMs < this.config.openingDurationMs
        || this.segmentStats.opening.count < this.config.minimumBaselineSamples;
      const segment = openingIncomplete ? "opening" : this.runningElapsedMs <= this.config.middleEndMs ? "middle" : "late";
      addMeasurement(this.segmentStats[segment], measurement);
      this.addRecentMeasurement(now, measurement);
      this.trackOrientation(unitGravity);
    }
    this.lastMovementState = movementState;
    return this.snapshot(now);
  }

  addRecentMeasurement(timestampMs, measurement) {
    const bucketAtMs = Math.floor(timestampMs / 1_000) * 1_000;
    let bucket = this.recentBuckets.at(-1);
    if (!bucket || bucket.atMs !== bucketAtMs) {
      bucket = { atMs: bucketAtMs, stats: emptyStats() };
      this.recentBuckets.push(bucket);
    }
    addMeasurement(bucket.stats, measurement);
    const oldest = timestampMs - this.config.rollingWindowMs;
    while (this.recentBuckets.length && this.recentBuckets[0].atMs + 1_000 < oldest) this.recentBuckets.shift();
  }

  trackOrientation(unitGravity) {
    this.referenceGravity ??= { ...unitGravity };
    const dot = this.referenceGravity.x * unitGravity.x
      + this.referenceGravity.y * unitGravity.y
      + this.referenceGravity.z * unitGravity.z;
    this.orientationSamples += 1;
    if (dot < this.config.orientationDotThreshold) this.orientationMismatchCount += 1;
  }

  metricsFromStats(stats) {
    if (!stats?.count) return null;
    const impactMean = stats.impactSum / stats.count;
    const impactVariance = Math.max(0, stats.impactSq / stats.count - impactMean * impactMean);
    return {
      verticalRms: round(Math.sqrt(stats.verticalSq / stats.count)),
      horizontalRms: round(Math.sqrt(stats.horizontalSq / stats.count)),
      rotationRms: stats.rotationCount ? round(Math.sqrt(stats.rotationSq / stats.rotationCount), 1) : null,
      rotationCoverage: round(stats.rotationCount / stats.count, 2),
      impactVariation: round(impactMean ? Math.sqrt(impactVariance) / impactMean : null, 3),
      sampleCount: stats.count
    };
  }

  changeBetween(baseline, current, key) {
    const original = baseline?.[key];
    const latest = current?.[key];
    return original && latest !== null && latest !== undefined ? Math.round((latest / original - 1) * 100) : null;
  }

  driftBetween(baseline, current) {
    return {
      verticalPercent: this.changeBetween(baseline, current, "verticalRms"),
      horizontalPercent: this.changeBetween(baseline, current, "horizontalRms"),
      rotationPercent: this.changeBetween(baseline, current, "rotationRms"),
      impactPercent: this.changeBetween(baseline, current, "impactVariation")
    };
  }

  exportState() {
    return {
      version: 2,
      config: this.config,
      state: {
        startedAtMs: this.startedAtMs,
        lastSampleAtMs: this.lastSampleAtMs,
        lastMovementState: this.lastMovementState,
        gravity: this.gravity,
        referenceGravity: this.referenceGravity,
        totalSamples: this.totalSamples,
        runningSamples: this.runningSamples,
        runningElapsedMs: this.runningElapsedMs,
        sampleGapCount: this.sampleGapCount,
        orientationSamples: this.orientationSamples,
        orientationMismatchCount: this.orientationMismatchCount,
        segmentStats: this.segmentStats,
        recentBuckets: this.recentBuckets
      }
    };
  }

  restoreState(payload, timestampMs = 0) {
    if (!payload || payload.version !== 2 || !payload.state) throw new TypeError("Unsupported hip form state.");
    this.config = { ...DEFAULT_FORM_CONFIG, ...(payload.config || {}) };
    this.reset();
    const now = finite(timestampMs) ?? 0;
    const previousNow = finite(payload.state.lastSampleAtMs) ?? now;
    const shift = now - previousNow;
    Object.assign(this, payload.state);
    this.startedAtMs = finite(payload.state.startedAtMs) === null ? now : payload.state.startedAtMs + shift;
    this.lastSampleAtMs = now;
    this.lastMovementState = "unknown";
    this.segmentStats = payload.state.segmentStats || { opening: emptyStats(), middle: emptyStats(), late: emptyStats() };
    this.recentBuckets = (payload.state.recentBuckets || []).map(bucket => ({ ...bucket, atMs: bucket.atMs + shift }));
    this.cachedSnapshot = null;
    return this.snapshot(now, { force: true });
  }

  snapshot(timestampMs = this.lastSampleAtMs ?? this.startedAtMs ?? 0, { force = false } = {}) {
    const now = finite(timestampMs) ?? 0;
    if (!force && this.cachedSnapshot && now - this.lastSnapshotAtMs < this.config.summaryIntervalMs) return this.cachedSnapshot;
    const opening = this.metricsFromStats(this.segmentStats.opening);
    const middle = this.metricsFromStats(this.segmentStats.middle);
    const late = this.metricsFromStats(this.segmentStats.late);
    const recentStats = this.recentBuckets.reduce((stats, bucket) => mergeStats(stats, bucket.stats), emptyStats());
    const recent = this.metricsFromStats(recentStats);
    const timeProgress = clamp(this.runningElapsedMs / Math.max(1, this.config.openingDurationMs), 0, 1);
    const sampleProgress = clamp((opening?.sampleCount || 0) / Math.max(1, this.config.minimumBaselineSamples), 0, 1);
    const baselineReady = timeProgress >= 1 && sampleProgress >= 1;
    const observedRate = this.runningElapsedMs > 0 ? this.runningSamples / (this.runningElapsedMs / 1_000) : 0;
    const sampleScore = clamp(observedRate / this.config.expectedSampleRateHz, 0, 1);
    const gapPenalty = clamp(1 - this.sampleGapCount / 10, 0.35, 1);
    const mismatchRatio = this.orientationSamples ? this.orientationMismatchCount / this.orientationSamples : 0;
    const placementConsistent = this.orientationSamples < 20 ? null : mismatchRatio <= this.config.orientationMismatchRatio;
    const placementPenalty = placementConsistent === false ? 0.65 : 1;
    const rotationCoverage = opening?.rotationCoverage || 0;
    const rotationAvailable = rotationCoverage >= 0.5;
    const confidence = Math.round((sampleScore * 0.45 + timeProgress * 0.35 + sampleProgress * 0.2) * gapPenalty * placementPenalty * 100);
    const phase = !baselineReady ? "opening" : this.runningElapsedMs <= this.config.middleEndMs ? "middle" : "late";

    this.cachedSnapshot = {
      baselineReady,
      baselineProgress: Math.round(Math.min(timeProgress, sampleProgress) * 100),
      confidence,
      opening,
      recent,
      segments: { opening, middle, late },
      segmentDrift: { middle: this.driftBetween(opening, middle), late: this.driftBetween(opening, late) },
      phase,
      drift: baselineReady ? this.driftBetween(opening, recent) : this.driftBetween(null, null),
      capabilities: { rotationAvailable, rotationCoverage },
      placementConsistent,
      orientationMismatchRatio: round(mismatchRatio, 3),
      sampleGapCount: this.sampleGapCount,
      totalSamples: this.totalSamples,
      runningElapsedMs: this.runningElapsedMs
    };
    this.lastSnapshotAtMs = now;
    return this.cachedSnapshot;
  }
}
