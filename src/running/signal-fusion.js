const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const GARMIN_TELEMETRY_VERSION = 1;

export function normalizeGarminTelemetry(payload = {}) {
  if (payload.type !== "run-telemetry" || Number(payload.version) !== GARMIN_TELEMETRY_VERSION) {
    throw new TypeError("Unsupported Garmin run telemetry message.");
  }
  const timestampMs = finite(payload.timestampMs);
  if (timestampMs === null) throw new TypeError("Garmin telemetry requires timestampMs.");
  return {
    type: "run-telemetry",
    version: GARMIN_TELEMETRY_VERSION,
    timestampMs,
    cadenceSpm: finite(payload.cadenceSpm),
    heartRateBpm: finite(payload.heartRateBpm),
    speedMps: finite(payload.speedMps),
    timerState: typeof payload.timerState === "string" ? payload.timerState : "unknown"
  };
}

export class RunSignalFusion {
  constructor({ garminFreshMs = 5_000 } = {}) {
    this.garminFreshMs = garminFreshMs;
    this.phone = null;
    this.garmin = null;
  }

  updatePhone(sample = {}) {
    const timestampMs = finite(sample.timestampMs);
    if (timestampMs === null) throw new TypeError("Phone motion sample requires timestampMs.");
    this.phone = {
      timestampMs,
      cadenceSpm: finite(sample.cadenceSpm),
      movementState: sample.movementState || "unknown",
      motionIntensity: finite(sample.motionIntensity)
    };
    return this.snapshot(timestampMs);
  }

  updateGarmin(payload) {
    this.garmin = normalizeGarminTelemetry(payload);
    return this.snapshot(this.garmin.timestampMs);
  }

  snapshot(timestampMs) {
    const now = finite(timestampMs) ?? this.phone?.timestampMs ?? this.garmin?.timestampMs ?? 0;
    const garminFresh = Boolean(this.garmin) && now - this.garmin.timestampMs <= this.garminFreshMs;
    const useGarminCadence = garminFresh && this.garmin.cadenceSpm !== null;
    const cadenceSpm = useGarminCadence ? this.garmin.cadenceSpm : this.phone?.cadenceSpm ?? null;
    let movementState = this.phone?.movementState || "unknown";

    if (garminFresh && this.garmin.timerState === "paused") movementState = "stopped";
    else if (garminFresh && this.garmin.cadenceSpm !== null && this.garmin.speedMps !== null) {
      if (this.garmin.speedMps < 0.35 && this.garmin.cadenceSpm < 20) movementState = "stopped";
      else if (this.garmin.cadenceSpm >= 130) movementState = "running";
      else if (this.garmin.cadenceSpm >= 45) movementState = "walking";
    }

    return {
      timestampMs: now,
      cadenceSpm,
      movementState,
      cadenceSource: useGarminCadence
        ? "garmin"
        : this.phone?.cadenceSpm != null
          ? "phone"
          : "none",
      motionIntensity: this.phone?.motionIntensity ?? null,
      heartRateBpm: garminFresh ? this.garmin.heartRateBpm : null,
      speedMps: garminFresh ? this.garmin.speedMps : null,
      garminConnected: garminFresh
    };
  }
}
