const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const magnitude3 = value => {
  if (!value) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const z = finite(value.z);
  if (x === null || y === null || z === null) return null;
  return Math.sqrt(x * x + y * y + z * z);
};

export const DEFAULT_MOTION_CONFIG = Object.freeze({
  cadenceWindowMs: 8_000,
  intensityWindowMs: 2_000,
  stepRefractoryMs: 250,
  stoppedAfterMs: 2_500,
  runningCadenceSpm: 130,
  walkingCadenceSpm: 55,
  minimumPeak: 0.8,
  thresholdMargin: 0.55
});

export class HipMotionCadenceDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_MOTION_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.gravityMagnitude = null;
    this.lastMagnitude = 0;
    this.lastStepAtMs = null;
    this.stepTimes = [];
    this.intensitySamples = [];
    this.noiseFloor = 0.15;
    this.lastSnapshot = {
      cadenceSpm: null,
      movementState: "unknown",
      motionIntensity: 0,
      stepDetected: false,
      stepCount: 0
    };
  }

  update({ timestampMs, acceleration = null, accelerationIncludingGravity = null } = {}) {
    const now = finite(timestampMs);
    if (now === null) throw new TypeError("HipMotionCadenceDetector.update requires a numeric timestampMs.");

    let motionMagnitude = magnitude3(acceleration);
    if (motionMagnitude === null) {
      const withGravity = magnitude3(accelerationIncludingGravity);
      if (withGravity === null) return this.snapshot(now, false);
      this.gravityMagnitude ??= withGravity;
      this.gravityMagnitude = this.gravityMagnitude * 0.94 + withGravity * 0.06;
      motionMagnitude = Math.abs(withGravity - this.gravityMagnitude);
    }
    return this.updateMagnitude(now, motionMagnitude);
  }

  updateMagnitude(timestampMs, motionMagnitude) {
    const now = finite(timestampMs);
    const magnitude = Math.max(0, finite(motionMagnitude) ?? 0);
    if (now === null) throw new TypeError("HipMotionCadenceDetector.updateMagnitude requires a numeric timestampMs.");

    this.intensitySamples.push({ at: now, value: magnitude });
    this.intensitySamples = this.intensitySamples.filter(sample => now - sample.at <= this.config.intensityWindowMs);

    const sorted = this.intensitySamples.map(sample => sample.value).sort((a, b) => a - b);
    if (sorted.length >= 8) {
      const lowerQuartile = sorted[Math.floor(sorted.length * 0.25)];
      this.noiseFloor = this.noiseFloor * 0.9 + lowerQuartile * 0.1;
    }
    const threshold = Math.max(this.config.minimumPeak, this.noiseFloor + this.config.thresholdMargin);
    const crossedPeak = magnitude >= threshold && this.lastMagnitude < threshold;
    const refractoryReady = this.lastStepAtMs === null || now - this.lastStepAtMs >= this.config.stepRefractoryMs;
    const stepDetected = crossedPeak && refractoryReady;

    if (stepDetected) {
      this.lastStepAtMs = now;
      this.stepTimes.push(now);
    }
    this.lastMagnitude = magnitude;
    this.stepTimes = this.stepTimes.filter(at => now - at <= this.config.cadenceWindowMs);
    return this.snapshot(now, stepDetected);
  }

  snapshot(timestampMs, stepDetected = false) {
    const now = finite(timestampMs) ?? 0;
    let cadenceSpm = null;
    if (this.stepTimes.length >= 3) {
      const durationMs = this.stepTimes.at(-1) - this.stepTimes[0];
      if (durationMs > 0) cadenceSpm = (this.stepTimes.length - 1) * 60_000 / durationMs;
    }

    const intensity = this.intensitySamples.length
      ? Math.sqrt(this.intensitySamples.reduce((total, sample) => total + sample.value * sample.value, 0) / this.intensitySamples.length)
      : 0;
    const stale = this.lastStepAtMs === null || now - this.lastStepAtMs >= this.config.stoppedAfterMs;
    let movementState = "unknown";
    if (stale) movementState = "stopped";
    else if (cadenceSpm !== null && cadenceSpm >= this.config.runningCadenceSpm) movementState = "running";
    else if (cadenceSpm !== null && cadenceSpm >= this.config.walkingCadenceSpm) movementState = "walking";
    else movementState = "moving";

    this.lastSnapshot = {
      cadenceSpm: cadenceSpm === null ? null : Math.round(cadenceSpm),
      movementState,
      motionIntensity: Math.round(intensity * 100) / 100,
      stepDetected,
      stepCount: this.stepTimes.length
    };
    return { ...this.lastSnapshot };
  }
}
