const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value, places = 1) => value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const emptyStats = () => ({
  count: 0,
  intervalCount: 0,
  intervalSum: 0,
  intervalSq: 0,
  positiveIntervalCount: 0,
  positiveIntervalSum: 0,
  positiveIntervalSq: 0,
  negativeIntervalCount: 0,
  negativeIntervalSum: 0,
  negativeIntervalSq: 0,
  rangeCount: 0,
  rangeSum: 0,
  rangeSq: 0
});

const normalizedStats = stats => Object.fromEntries(
  Object.entries({ ...emptyStats(), ...(stats || {}) })
    .map(([key, value]) => [key, finite(value) ?? 0])
);

const emptyCandidate = () => ({
  samples: 0,
  mean: [0, 0, 0],
  m2: [0, 0, 0]
});

const addCandidateSample = (candidate, vector) => {
  candidate.samples += 1;
  vector.forEach((value, index) => {
    const delta = value - candidate.mean[index];
    candidate.mean[index] += delta / candidate.samples;
    candidate.m2[index] += delta * (value - candidate.mean[index]);
  });
};

const directionalRegularityFromStats = stats => {
  const directions = ["positive", "negative"]
    .map(prefix => {
      const count = stats[`${prefix}IntervalCount`] || 0;
      if (count < 2) return null;
      const mean = stats[`${prefix}IntervalSum`] / count;
      const variance = Math.max(0, stats[`${prefix}IntervalSq`] / count - mean * mean);
      const cv = mean ? Math.sqrt(variance) / mean : null;
      return cv === null ? null : { count, score: clamp(1 - cv / 0.3, 0, 1) };
    })
    .filter(Boolean);
  if (!directions.length) return null;
  const weight = directions.reduce((total, item) => total + item.count, 0);
  return Math.round(directions.reduce((total, item) => total + item.score * item.count, 0) / weight * 100);
};

const typicalDirectionalInterval = swings => {
  const positive = median(swings.filter(swing => swing.direction > 0).map(swing => swing.intervalMs).filter(Number.isFinite));
  const negative = median(swings.filter(swing => swing.direction < 0).map(swing => swing.intervalMs).filter(Number.isFinite));
  if (positive !== null && negative !== null) return (positive + negative) / 2;
  return median(swings.map(swing => swing.intervalMs).filter(Number.isFinite));
};

const addSwing = (stats, { intervalMs, rangeValue, direction }) => {
  stats.count += 1;
  if (Number.isFinite(intervalMs)) {
    stats.intervalCount += 1;
    stats.intervalSum += intervalMs;
    stats.intervalSq += intervalMs * intervalMs;
    const prefix = direction > 0 ? "positive" : "negative";
    stats[`${prefix}IntervalCount`] += 1;
    stats[`${prefix}IntervalSum`] += intervalMs;
    stats[`${prefix}IntervalSq`] += intervalMs * intervalMs;
  }
  if (Number.isFinite(rangeValue)) {
    stats.rangeCount += 1;
    stats.rangeSum += rangeValue;
    stats.rangeSq += rangeValue * rangeValue;
  }
};

const mergeStats = (target, source) => {
  for (const key of Object.keys(target)) target[key] += finite(source?.[key]) ?? 0;
  return target;
};

const COMPARISON_BUCKET_MS = 1_000;
const MINIMUM_COMPARISON_HISTORY_MS = 20 * 60_000;
const STATS_KEYS = Object.freeze(Object.keys(emptyStats()));

const encodeBucket = bucket => [
  bucket.atMs,
  ...STATS_KEYS.map(key => finite(bucket.stats?.[key]) ?? 0)
];

const decodeBucket = value => {
  if (Array.isArray(value)) {
    const atMs = finite(value[0]);
    if (atMs === null) return null;
    const stats = emptyStats();
    STATS_KEYS.forEach((key, index) => {
      stats[key] = finite(value[index + 1]) ?? 0;
    });
    return { atMs, stats };
  }
  const atMs = finite(value?.atMs);
  return atMs === null ? null : { atMs, stats: normalizedStats(value.stats) };
};

const vectorFrom = (value, keys) => {
  if (!value) return null;
  const vector = keys.map(key => finite(value[key]));
  return vector.some(item => item !== null) ? vector.map(item => item ?? 0) : null;
};

export const DEFAULT_ARM_SWING_CONFIG = Object.freeze({
  openingDurationMs: 10 * 60_000,
  middleEndMs: 40 * 60_000,
  minimumBaselineSwings: 300,
  minimumSampleIntervalMs: 45,
  maximumRunningIntervalMs: 250,
  recentWindowMs: 30_000,
  cadenceWindowMs: 8_000,
  maximumRecentSwings: 120,
  comparisonHistoryMs: MINIMUM_COMPARISON_HISTORY_MS,
  minimumHalfSwingMs: 250,
  maximumHalfSwingMs: 600,
  stoppedAfterMs: 2_500,
  runningCadenceSpm: 130,
  walkingCadenceSpm: 55,
  expectedSampleRateHz: 10,
  sourceSelectionSamples: 20,
  gyroMinimumThreshold: 8,
  accelerationMinimumThreshold: 0.35,
  thresholdScale: 0.36,
  biasAlpha: 0.018,
  varianceAlpha: 0.04,
  axisHysteresis: 1.35,
  axisLockSamples: 20,
  summaryIntervalMs: 1_000
});

export class ArmSwingAnalyzer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_ARM_SWING_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.startedAtMs = null;
    this.lastSampleAtMs = null;
    this.lastMovementState = "unknown";
    this.totalSamples = 0;
    this.usableSamples = 0;
    this.runningSamples = 0;
    this.gyroSamples = 0;
    this.accelerationSamples = 0;
    this.runningElapsedMs = 0;
    this.sampleGapCount = 0;
    this.recordedSwings = 0;
    this.source = null;
    this.sourceLocked = false;
    this.sourceCandidates = {
      gyro: emptyCandidate(),
      accelerationLinear: emptyCandidate(),
      accelerationGravity: emptyCandidate()
    };
    this.accelerationMode = null;
    this.sourceSamples = 0;
    this.bias = [0, 0, 0];
    this.axisVariance = [0, 0, 0];
    this.filterReady = false;
    this.dominantAxis = null;
    this.axisSwitchCount = 0;
    this.rangeBaselineValid = true;
    this.axisValidationPending = false;
    this.axisValidationSamples = 0;
    this.lastSign = 0;
    this.lastCrossingAtMs = null;
    this.lastSwingAtMs = null;
    this.rangeAccumulator = 0;
    this.signalIntensity = 0;
    this.liveSwings = [];
    this.recentMeasurements = [];
    this.comparisonBuckets = [];
    this.segmentStats = { opening: emptyStats(), middle: emptyStats(), late: emptyStats() };
    this.latestCadenceSpm = null;
    this.latestCadenceSource = "none";
    this.lastSnapshotAtMs = -Infinity;
    this.cachedSnapshot = null;
  }

  start(timestampMs = 0) {
    this.reset();
    this.startedAtMs = finite(timestampMs) ?? 0;
    return this.snapshot(this.startedAtMs, { force: true });
  }

  resetLiveSwing() {
    this.lastSign = 0;
    this.lastCrossingAtMs = null;
    this.lastSwingAtMs = null;
    this.rangeAccumulator = 0;
    this.liveSwings = [];
    this.lastMovementState = "unknown";
  }

  availableSignals({ rotationRate, acceleration, accelerationIncludingGravity }) {
    const gyro = vectorFrom(rotationRate, ["alpha", "beta", "gamma"]);
    const linear = vectorFrom(acceleration, ["x", "y", "z"]);
    const withGravity = vectorFrom(accelerationIncludingGravity, ["x", "y", "z"]);
    return { gyro, accelerationLinear: linear, accelerationGravity: withGravity };
  }

  candidateScore(source) {
    const candidate = this.sourceCandidates[source];
    if (!candidate || candidate.samples < 2) return 0;
    const standardDeviation = Math.sqrt(Math.max(...candidate.m2) / (candidate.samples - 1));
    const minimum = source === "gyro" ? this.config.gyroMinimumThreshold : this.config.accelerationMinimumThreshold;
    return minimum > 0 ? standardDeviation / minimum : 0;
  }

  lockSource(source, vector) {
    this.source = source === "gyro" ? "gyro" : "acceleration";
    this.accelerationMode = source === "accelerationLinear"
      ? "linear"
      : source === "accelerationGravity" ? "gravity" : null;
    this.sourceLocked = true;
    this.sourceSamples = 0;
    this.bias = [...vector];
    this.axisVariance = [0, 0, 0];
    this.filterReady = false;
    this.dominantAxis = null;
    this.resetLiveSwing();
  }

  selectSignal(inputs) {
    const signals = this.availableSignals(inputs);
    if (this.sourceLocked) {
      const sourceKey = this.source === "gyro"
        ? "gyro"
        : this.accelerationMode === "gravity" ? "accelerationGravity" : "accelerationLinear";
      const vector = signals[sourceKey];
      return vector ? { source: this.source, vector } : null;
    }

    for (const source of ["gyro", "accelerationLinear", "accelerationGravity"]) {
      if (signals[source]) addCandidateSample(this.sourceCandidates[source], signals[source]);
    }
    const enoughSamples = Math.max(
      this.sourceCandidates.gyro.samples,
      this.sourceCandidates.accelerationLinear.samples,
      this.sourceCandidates.accelerationGravity.samples
    ) >= this.config.sourceSelectionSamples;
    if (!enoughSamples) return null;

    const gyroReady = signals.gyro && this.candidateScore("gyro") >= 1;
    const accelerationOptions = ["accelerationLinear", "accelerationGravity"]
      .filter(source => signals[source] && this.candidateScore(source) >= 1)
      .sort((left, right) => this.candidateScore(right) - this.candidateScore(left));
    const source = gyroReady ? "gyro" : accelerationOptions[0] || null;
    if (!source) return null;
    this.lockSource(source, signals[source]);
    return { source: this.source, vector: signals[source] };
  }

  update({
    timestampMs,
    rotationRate = null,
    acceleration = null,
    accelerationIncludingGravity = null,
    cadenceSpm = null,
    cadenceSource = "none",
    movementStateOverride = null,
    recordingAllowed = true
  } = {}) {
    const now = finite(timestampMs);
    if (now === null) throw new TypeError("ArmSwingAnalyzer.update requires a numeric timestampMs.");
    if (this.startedAtMs === null) this.start(now);

    const selected = this.selectSignal({ rotationRate, acceleration, accelerationIncludingGravity });
    if (!selected) return this.liveSnapshot(now, false);
    if (this.lastSampleAtMs !== null && now - this.lastSampleAtMs < this.config.minimumSampleIntervalMs) {
      return this.liveSnapshot(now, false);
    }

    const intervalMs = this.lastSampleAtMs === null ? 0 : Math.max(0, now - this.lastSampleAtMs);
    if (intervalMs > this.config.maximumRunningIntervalMs) {
      this.sampleGapCount += 1;
      this.resetLiveSwing();
    }
    this.lastSampleAtMs = now;
    this.totalSamples += 1;
    this.usableSamples += 1;
    if (selected.source === "gyro") this.gyroSamples += 1;
    else this.accelerationSamples += 1;

    this.sourceSamples += 1;

    const centered = selected.vector.map((value, index) => {
      if (!this.filterReady) this.bias[index] = value;
      else this.bias[index] = this.bias[index] * (1 - this.config.biasAlpha) + value * this.config.biasAlpha;
      const result = value - this.bias[index];
      this.axisVariance[index] = this.axisVariance[index] * (1 - this.config.varianceAlpha)
        + result * result * this.config.varianceAlpha;
      return result;
    });
    this.filterReady = true;

    const strongestAxis = this.axisVariance.indexOf(Math.max(...this.axisVariance));
    const previousAxis = this.dominantAxis;
    if (this.axisValidationPending) {
      this.axisValidationSamples += 1;
      if (this.axisValidationSamples >= this.config.axisLockSamples) {
        this.axisValidationPending = false;
        if (previousAxis !== null && previousAxis !== strongestAxis) {
          this.dominantAxis = strongestAxis;
          this.axisSwitchCount += 1;
          this.rangeBaselineValid = false;
          this.resetLiveSwing();
        }
      }
    } else if (previousAxis === null || this.axisVariance[strongestAxis] > this.axisVariance[previousAxis] * this.config.axisHysteresis) {
      this.dominantAxis = strongestAxis;
      if (previousAxis !== null && previousAxis !== strongestAxis) {
        if (this.sourceSamples >= this.config.axisLockSamples && this.recordedSwings > 0) {
          this.axisSwitchCount += 1;
          this.rangeBaselineValid = false;
        }
        this.resetLiveSwing();
      }
    }

    const signal = centered[this.dominantAxis ?? strongestAxis] ?? 0;
    this.signalIntensity = this.signalIntensity * 0.92 + Math.abs(signal) * 0.08;
    if (intervalMs > 0 && intervalMs <= this.config.maximumRunningIntervalMs) {
      this.rangeAccumulator += Math.abs(signal) * intervalMs / 1_000;
    }

    const minimumThreshold = selected.source === "gyro"
      ? this.config.gyroMinimumThreshold
      : this.config.accelerationMinimumThreshold;
    const adaptiveThreshold = Math.sqrt(this.axisVariance[this.dominantAxis ?? strongestAxis] || 0) * this.config.thresholdScale;
    const threshold = Math.max(minimumThreshold, adaptiveThreshold);
    const sign = signal >= threshold ? 1 : signal <= -threshold ? -1 : 0;
    let halfSwingDetected = false;
    let detectedSwing = null;

    if (!recordingAllowed) {
      this.resetLiveSwing();
    } else if (sign !== 0) {
      if (this.lastSign === 0) {
        this.lastSign = sign;
        this.lastCrossingAtMs = now;
        this.rangeAccumulator = 0;
      } else if (sign !== this.lastSign) {
        const halfSwingMs = now - this.lastCrossingAtMs;
        if (halfSwingMs >= this.config.minimumHalfSwingMs) {
          const rangeValue = this.rangeAccumulator;
          this.lastSign = sign;
          this.lastCrossingAtMs = now;
          this.rangeAccumulator = 0;
          if (halfSwingMs <= this.config.maximumHalfSwingMs) {
            detectedSwing = { atMs: now, intervalMs: halfSwingMs, rangeValue, direction: sign, source: selected.source };
            this.liveSwings.push(detectedSwing);
            this.lastSwingAtMs = now;
            halfSwingDetected = true;
          } else {
            this.liveSwings = [];
          }
        }
      }
    }

    this.liveSwings = this.liveSwings
      .filter(swing => now - swing.atMs <= this.config.cadenceWindowMs)
      .slice(-40);
    const equivalentCadenceSpm = this.currentEquivalentCadence();
    const stale = this.lastSwingAtMs === null || now - this.lastSwingAtMs >= this.config.stoppedAfterMs;
    let movementState = "unknown";
    if (stale) movementState = "stopped";
    else if (equivalentCadenceSpm !== null && equivalentCadenceSpm >= this.config.runningCadenceSpm) movementState = "running";
    else if (equivalentCadenceSpm !== null && equivalentCadenceSpm >= this.config.walkingCadenceSpm) movementState = "walking";
    else movementState = "moving";
    if (["running", "walking", "stopped"].includes(movementStateOverride)) movementState = movementStateOverride;

    if (recordingAllowed && movementState === "running") {
      this.runningSamples += 1;
      if (this.lastMovementState === "running" && intervalMs <= this.config.maximumRunningIntervalMs) {
        this.runningElapsedMs += intervalMs;
      }
      if (detectedSwing) {
        const openingIncomplete = this.runningElapsedMs < this.config.openingDurationMs
          || this.segmentStats.opening.count < this.config.minimumBaselineSwings;
        const segment = openingIncomplete ? "opening" : this.runningElapsedMs <= this.config.middleEndMs ? "middle" : "late";
        addSwing(this.segmentStats[segment], detectedSwing);
        this.recordedSwings += 1;
        this.recentMeasurements.push(detectedSwing);
        this.addComparisonSwing(detectedSwing);
      }
    }
    this.lastMovementState = recordingAllowed ? movementState : "unknown";
    this.recentMeasurements = this.recentMeasurements
      .filter(swing => now - swing.atMs <= this.config.recentWindowMs)
      .slice(-this.config.maximumRecentSwings);

    const cadence = finite(cadenceSpm);
    this.latestCadenceSpm = cadenceSource === "garmin" ? cadence : null;
    this.latestCadenceSource = cadenceSource === "garmin" && cadence !== null ? "garmin" : "none";
    return this.liveSnapshot(now, halfSwingDetected, movementState, equivalentCadenceSpm);
  }

  addComparisonSwing(swing) {
    const bucketAtMs = Math.floor(swing.atMs / COMPARISON_BUCKET_MS) * COMPARISON_BUCKET_MS;
    let bucket = this.comparisonBuckets.at(-1);
    if (!bucket || bucket.atMs !== bucketAtMs) {
      bucket = { atMs: bucketAtMs, stats: emptyStats() };
      this.comparisonBuckets.push(bucket);
    }
    addSwing(bucket.stats, swing);
    const comparisonHistoryMs = Math.max(
      MINIMUM_COMPARISON_HISTORY_MS,
      finite(this.config.comparisonHistoryMs) ?? MINIMUM_COMPARISON_HISTORY_MS
    );
    const comparisonOldest = swing.atMs - comparisonHistoryMs;
    while (this.comparisonBuckets.length && this.comparisonBuckets[0].atMs < comparisonOldest) {
      this.comparisonBuckets.shift();
    }
  }

  windowMetrics(startMs, endMs) {
    const start = finite(startMs);
    const end = finite(endMs);
    if (start === null || end === null || end <= start) {
      throw new TypeError("Arm swing window requires numeric startMs and endMs with endMs after startMs.");
    }
    if (start % COMPARISON_BUCKET_MS !== 0 || end % COMPARISON_BUCKET_MS !== 0) {
      throw new RangeError("Arm swing comparison windows must use exact one-second boundaries.");
    }
    const buckets = this.comparisonBuckets.filter(bucket => bucket.atMs >= start && bucket.atMs < end);
    const stats = buckets.reduce((total, bucket) => mergeStats(total, bucket.stats), emptyStats());
    const metrics = this.metricsFromStats(stats);
    const expectedBucketCount = Math.ceil((end - start) / COMPARISON_BUCKET_MS);
    const observedBucketCount = buckets.length;
    const coverageRatio = round(expectedBucketCount ? observedBucketCount / expectedBucketCount : 0, 3);
    return {
      startMs: start,
      endMs: end,
      durationMs: end - start,
      bucketSizeMs: COMPARISON_BUCKET_MS,
      sampleCount: metrics?.swingCount ?? 0,
      observedBucketCount,
      expectedBucketCount,
      coverageRatio,
      coveragePercent: Math.round(coverageRatio * 100),
      metrics,
      aggregate: { kind: "arm", ...stats }
    };
  }

  currentEquivalentCadence() {
    if (this.liveSwings.length < 3) return null;
    const typicalHalfSwingMs = typicalDirectionalInterval(this.liveSwings);
    if (!typicalHalfSwingMs) return null;
    return 60_000 / typicalHalfSwingMs;
  }

  metricsFromStats(stats) {
    if (!stats?.count) return null;
    const positiveMean = stats.positiveIntervalCount ? stats.positiveIntervalSum / stats.positiveIntervalCount : null;
    const negativeMean = stats.negativeIntervalCount ? stats.negativeIntervalSum / stats.negativeIntervalCount : null;
    const intervalMean = positiveMean !== null && negativeMean !== null
      ? (positiveMean + negativeMean) / 2
      : stats.intervalCount ? stats.intervalSum / stats.intervalCount : null;
    const rangeMean = stats.rangeCount ? stats.rangeSum / stats.rangeCount : null;
    return {
      swingCount: stats.count,
      equivalentCadenceSpm: intervalMean ? round(60_000 / intervalMean) : null,
      armCycleRpm: intervalMean ? round(30_000 / intervalMean) : null,
      regularityPercent: directionalRegularityFromStats(stats),
      rangeMean: round(rangeMean, 3)
    };
  }

  recentMetrics() {
    if (!this.recentMeasurements.length) return null;
    const ranges = this.recentMeasurements.map(swing => swing.rangeValue).filter(Number.isFinite);
    const typicalInterval = typicalDirectionalInterval(this.recentMeasurements);
    const directionalScores = [1, -1]
      .map(direction => this.recentMeasurements
        .filter(swing => swing.direction === direction && Number.isFinite(swing.intervalMs))
        .map(swing => swing.intervalMs))
      .filter(values => values.length >= 2)
      .map(values => {
        const typical = median(values);
        const deviation = median(values.map(value => Math.abs(value - typical)));
        return { count: values.length, score: clamp(1 - deviation / typical / 0.22, 0, 1) };
      });
    const regularityWeight = directionalScores.reduce((total, item) => total + item.count, 0);
    const regularity = regularityWeight
      ? Math.round(directionalScores.reduce((total, item) => total + item.score * item.count, 0) / regularityWeight * 100)
      : null;
    return {
      swingCount: this.recentMeasurements.length,
      equivalentCadenceSpm: typicalInterval ? round(60_000 / typicalInterval) : null,
      armCycleRpm: typicalInterval ? round(30_000 / typicalInterval) : null,
      regularityPercent: regularity,
      rangeMean: round(ranges.length ? ranges.reduce((total, value) => total + value, 0) / ranges.length : null, 3)
    };
  }

  driftBetween(baseline, current, key) {
    const original = baseline?.[key];
    const latest = current?.[key];
    return original && latest !== null && latest !== undefined ? Math.round((latest / original - 1) * 100) : null;
  }

  liveSnapshot(timestampMs, halfSwingDetected = false, movementState = null, equivalentCadenceSpm = null) {
    const visible = this.snapshot(timestampMs);
    const liveCadence = equivalentCadenceSpm ?? this.currentEquivalentCadence();
    return {
      ...visible,
      equivalentCadenceSpm: liveCadence === null ? visible.equivalentCadenceSpm : round(liveCadence),
      armCycleRpm: liveCadence === null ? visible.armCycleRpm : round(liveCadence / 2),
      cadenceSpm: liveCadence === null ? null : Math.round(liveCadence),
      movementState: movementState || visible.movementState,
      motionIntensity: round(this.signalIntensity, 2),
      halfSwingDetected
    };
  }

  snapshot(timestampMs = this.lastSampleAtMs ?? this.startedAtMs ?? 0, { force = false } = {}) {
    const now = finite(timestampMs) ?? 0;
    if (!force && this.cachedSnapshot && now - this.lastSnapshotAtMs < this.config.summaryIntervalMs) return this.cachedSnapshot;
    const opening = this.metricsFromStats(this.segmentStats.opening);
    const middle = this.metricsFromStats(this.segmentStats.middle);
    const late = this.metricsFromStats(this.segmentStats.late);
    const recent = this.recentMetrics();
    const timeProgress = clamp(this.runningElapsedMs / Math.max(1, this.config.openingDurationMs), 0, 1);
    const swingProgress = clamp((opening?.swingCount || 0) / Math.max(1, this.config.minimumBaselineSwings), 0, 1);
    const baselineReady = timeProgress >= 1 && swingProgress >= 1;
    const sampleRate = this.runningElapsedMs > 0 ? this.runningSamples / (this.runningElapsedMs / 1_000) : 0;
    const sampleScore = clamp(sampleRate / this.config.expectedSampleRateHz, 0, 1);
    const recentScore = clamp((recent?.swingCount || 0) / 12, 0, 1);
    const sourceQuality = this.source === "gyro" ? 1 : this.source === "acceleration" ? 0.68 : 0;
    const gapPenalty = clamp(1 - this.sampleGapCount / 12, 0.4, 1);
    const axisPenalty = this.rangeBaselineValid ? 1 : 0.72;
    const confidence = Math.round((sampleScore * 0.25 + recentScore * 0.4 + Math.min(timeProgress, swingProgress) * 0.35)
      * sourceQuality * gapPenalty * axisPenalty * 100);
    const equivalentCadence = recent?.equivalentCadenceSpm ?? this.currentEquivalentCadence();
    const cadenceMatchPercent = this.latestCadenceSource === "garmin" && equivalentCadence && this.latestCadenceSpm
      ? Math.round(clamp(Math.min(equivalentCadence, this.latestCadenceSpm) / Math.max(equivalentCadence, this.latestCadenceSpm), 0, 1) * 100)
      : null;
    const rangeChangePercent = baselineReady && this.rangeBaselineValid
      ? this.driftBetween(opening, recent, "rangeMean")
      : null;
    const movementState = this.lastMovementState;

    this.cachedSnapshot = {
      baselineReady,
      baselineProgress: Math.round(Math.min(timeProgress, swingProgress) * 100),
      confidence,
      equivalentCadenceSpm: equivalentCadence === null ? null : round(equivalentCadence),
      armCycleRpm: equivalentCadence === null ? null : round(equivalentCadence / 2),
      regularityPercent: recent?.regularityPercent ?? null,
      rangeChangePercent,
      cadenceMatchPercent,
      movementState,
      motionIntensity: round(this.signalIntensity, 2),
      opening,
      recent,
      segments: { opening, middle, late },
      segmentDrift: {
        middle: { rangePercent: this.rangeBaselineValid ? this.driftBetween(opening, middle, "rangeMean") : null },
        late: { rangePercent: this.rangeBaselineValid ? this.driftBetween(opening, late, "rangeMean") : null }
      },
      phase: !baselineReady ? "opening" : this.runningElapsedMs <= this.config.middleEndMs ? "middle" : "late",
      capabilities: {
        gyroAvailable: this.source === "gyro",
        signalSource: this.source,
        rangeSource: this.source,
        cadenceMatchAvailable: cadenceMatchPercent !== null
      },
      placementConsistent: this.dominantAxis === null ? null : this.rangeBaselineValid,
      dominantAxis: this.dominantAxis,
      axisSwitchCount: this.axisSwitchCount,
      sampleGapCount: this.sampleGapCount,
      totalSamples: this.totalSamples,
      totalSwings: this.recordedSwings,
      runningElapsedMs: this.runningElapsedMs
    };
    this.lastSnapshotAtMs = now;
    return this.cachedSnapshot;
  }

  exportState() {
    return {
      version: 3,
      config: this.config,
      state: {
        startedAtMs: this.startedAtMs,
        lastSampleAtMs: this.lastSampleAtMs,
        totalSamples: this.totalSamples,
        usableSamples: this.usableSamples,
        runningSamples: this.runningSamples,
        gyroSamples: this.gyroSamples,
        accelerationSamples: this.accelerationSamples,
        runningElapsedMs: this.runningElapsedMs,
        sampleGapCount: this.sampleGapCount,
        recordedSwings: this.recordedSwings,
        source: this.source,
        sourceLocked: this.sourceLocked,
        accelerationMode: this.accelerationMode,
        sourceSamples: this.sourceSamples,
        dominantAxis: this.dominantAxis,
        axisSwitchCount: this.axisSwitchCount,
        rangeBaselineValid: this.rangeBaselineValid,
        segmentStats: this.segmentStats,
        comparisonBuckets: this.comparisonBuckets.map(encodeBucket)
      }
    };
  }

  restoreState(payload, timestampMs = 0) {
    if (!payload || ![1, 2, 3].includes(payload.version) || !payload.state) throw new TypeError("Unsupported arm swing state.");
    this.config = { ...DEFAULT_ARM_SWING_CONFIG, ...(payload.config || {}) };
    this.reset();
    const now = finite(timestampMs) ?? 0;
    const previousNow = finite(payload.state.lastSampleAtMs) ?? now;
    const shift = now - previousNow;
    const bucketShift = Math.floor(shift / COMPARISON_BUCKET_MS) * COMPARISON_BUCKET_MS;
    const previousOpenBucketMs = Math.floor(previousNow / COMPARISON_BUCKET_MS) * COMPARISON_BUCKET_MS;
    Object.assign(this, payload.state);
    this.startedAtMs = now;
    this.lastSampleAtMs = now;
    this.lastMovementState = "unknown";
    this.runningSamples = finite(payload.state.runningSamples) ?? 0;
    this.segmentStats = {
      opening: normalizedStats(payload.state.segmentStats?.opening),
      middle: normalizedStats(payload.state.segmentStats?.middle),
      late: normalizedStats(payload.state.segmentStats?.late)
    };
    const legacyAmbiguousAcceleration = payload.version === 1
      && payload.state.source === "acceleration"
      && !["linear", "gravity"].includes(payload.state.accelerationMode);
    this.source = legacyAmbiguousAcceleration
      ? null
      : ["gyro", "acceleration"].includes(payload.state.source) ? payload.state.source : null;
    this.sourceLocked = Boolean(this.source);
    this.accelerationMode = this.source === "acceleration" ? payload.state.accelerationMode : null;
    this.sourceSamples = finite(payload.state.sourceSamples) ?? 0;
    this.rangeBaselineValid = !legacyAmbiguousAcceleration && payload.state.rangeBaselineValid !== false;
    this.filterReady = false;
    this.bias = [0, 0, 0];
    this.axisVariance = [0, 0, 0];
    this.dominantAxis = legacyAmbiguousAcceleration
      ? null
      : [0, 1, 2].includes(payload.state.dominantAxis) ? payload.state.dominantAxis : null;
    this.axisValidationPending = this.dominantAxis !== null;
    this.axisValidationSamples = 0;
    this.liveSwings = [];
    this.recentMeasurements = [];
    this.lastSign = 0;
    this.lastCrossingAtMs = null;
    this.lastSwingAtMs = null;
    this.rangeAccumulator = 0;
    this.comparisonBuckets = (payload.version === 3 ? payload.state.comparisonBuckets || [] : [])
      .map(decodeBucket)
      .filter(Boolean)
      .filter(bucket => bucket.atMs < previousOpenBucketMs)
      .map(bucket => ({ ...bucket, atMs: bucket.atMs + bucketShift }))
      .filter(bucket => bucket.atMs < Math.floor(now / COMPARISON_BUCKET_MS) * COMPARISON_BUCKET_MS);
    const comparisonHistoryMs = Math.max(
      MINIMUM_COMPARISON_HISTORY_MS,
      finite(this.config.comparisonHistoryMs) ?? MINIMUM_COMPARISON_HISTORY_MS
    );
    const comparisonOldest = now - comparisonHistoryMs;
    while (this.comparisonBuckets.length && this.comparisonBuckets[0].atMs < comparisonOldest) {
      this.comparisonBuckets.shift();
    }
    this.cachedSnapshot = null;
    return this.snapshot(now, { force: true });
  }
}
