const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const DEFAULT_RUN_COACH_CONFIG = Object.freeze({
  baselineDurationMs: 120_000,
  baselineSampleEveryMs: 1_000,
  baselineMinSamples: 45,
  driftRatio: 0.06,
  driftHoldMs: 20_000,
  recoveryRatio: 0.03,
  recoveryHoldMs: 10_000,
  walkHoldMs: 5_000,
  stopHoldMs: 3_000,
  cueCooldownMs: 75_000,
  plannedBreakMs: 120_000,
  maxSampleGapMs: 2_000
});

export class RunRhythmCoach {
  constructor(config = {}) {
    this.config = { ...DEFAULT_RUN_COACH_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.startedAtMs = null;
    this.lastUpdateAtMs = null;
    this.lastBaselineSampleAtMs = -Infinity;
    this.baselineRunningMs = 0;
    this.baselineSamples = [];
    this.baselineCadenceSpm = null;
    this.locomotionState = "unknown";
    this.previousLocomotionState = "unknown";
    this.stateSinceMs = null;
    this.walkCandidateSinceMs = null;
    this.stopCandidateSinceMs = null;
    this.walkCounted = false;
    this.stopCounted = false;
    this.driftCandidateSinceMs = null;
    this.recoveryCandidateSinceMs = null;
    this.driftActive = false;
    this.excusedUntilMs = -Infinity;
    this.silencedUntilMs = -Infinity;
    this.lastCueAtMs = -Infinity;
    this.runningMs = 0;
    this.measuredRunningMs = 0;
    this.walkingMs = 0;
    this.stoppedMs = 0;
    this.stableRunningMs = 0;
    this.currentStableBlockMs = 0;
    this.longestStableBlockMs = 0;
    this.unplannedWalks = 0;
    this.stopCount = 0;
    this.lastCadenceSpm = null;
    this.lastStatus = "READY";
    this.lastMessage = "Ready for a steady opening run.";
  }

  start(timestampMs = 0) {
    this.reset();
    this.startedAtMs = timestampMs;
    this.lastUpdateAtMs = timestampMs;
    this.stateSinceMs = timestampMs;
    this.lastStatus = "CALIBRATING";
    this.lastMessage = "Run naturally while I learn your rhythm.";
    return this.snapshot(timestampMs);
  }

  exportState() {
    const state = {};
    for (const key of Object.keys(this)) {
      if (key === "config") continue;
      const value = this[key];
      state[key] = Number.isFinite(value) || value === null || typeof value !== "number" ? value : null;
    }
    return { version: 1, config: { ...this.config }, state };
  }

  restoreState(payload, timestampMs = 0) {
    if (!payload || payload.version !== 1 || !payload.state) throw new TypeError("Unsupported run coach state.");
    this.config = { ...DEFAULT_RUN_COACH_CONFIG, ...(payload.config || {}) };
    this.reset();
    const state = payload.state;
    const previousNow = finite(state.lastUpdateAtMs) ?? 0;
    const nextNow = finite(timestampMs) ?? 0;
    const shift = nextNow - previousNow;
    const timestampKeys = new Set([
      "startedAtMs", "lastUpdateAtMs", "lastBaselineSampleAtMs", "stateSinceMs",
      "walkCandidateSinceMs", "stopCandidateSinceMs", "driftCandidateSinceMs",
      "recoveryCandidateSinceMs", "excusedUntilMs", "silencedUntilMs", "lastCueAtMs"
    ]);
    for (const [key, value] of Object.entries(state)) {
      if (!(key in this)) continue;
      if (timestampKeys.has(key)) {
        if (value === null) {
          this[key] = ["excusedUntilMs", "silencedUntilMs", "lastCueAtMs", "lastBaselineSampleAtMs"].includes(key) ? -Infinity : null;
        } else {
          this[key] = Number(value) + shift;
        }
      } else if (Array.isArray(this[key])) {
        this[key] = Array.isArray(value) ? [...value] : [];
      } else {
        this[key] = value;
      }
    }
    if (!("measuredRunningMs" in state)) this.measuredRunningMs = finite(state.runningMs) ?? 0;
    this.lastUpdateAtMs = nextNow;
    return this.snapshot(nextNow);
  }

  markPlannedBreak(timestampMs, durationMs = this.config.plannedBreakMs) {
    const now = finite(timestampMs) ?? this.lastUpdateAtMs ?? 0;
    this.excusedUntilMs = Math.max(this.excusedUntilMs, now + Math.max(0, durationMs));
    this.lastStatus = "PLANNED WALK";
    this.lastMessage = "Planned walk marked. I will wait for you to resume.";
    return this.snapshot(now, [{ type: "planned-break", message: this.lastMessage, speak: true }]);
  }

  resumePlannedBreak(timestampMs) {
    const now = finite(timestampMs) ?? this.lastUpdateAtMs ?? 0;
    this.excusedUntilMs = -Infinity;
    this.lastStatus = this.baselineCadenceSpm === null ? "CALIBRATING" : "RESET";
    this.lastMessage = "Planned walk ended. Settle back into your natural rhythm.";
    return this.snapshot(now, [{ type: "planned-break-ended", message: this.lastMessage, speak: true }]);
  }

  silence(timestampMs, durationMs = 600_000) {
    const now = finite(timestampMs) ?? this.lastUpdateAtMs ?? 0;
    this.silencedUntilMs = Math.max(this.silencedUntilMs, now + Math.max(0, durationMs));
    this.lastMessage = "Voice coaching paused.";
    return this.snapshot(now, [{ type: "silenced", message: this.lastMessage, speak: true }]);
  }

  update({ timestampMs, cadenceSpm = null, movementState = "unknown" } = {}) {
    const now = finite(timestampMs);
    if (now === null) throw new TypeError("RunRhythmCoach.update requires a numeric timestampMs.");
    if (this.startedAtMs === null) this.start(now);

    const events = [];
    const cadence = finite(cadenceSpm);
    const nextState = this.normaliseMovementState(movementState, cadence);
    const deltaMs = clamp(now - this.lastUpdateAtMs, 0, this.config.maxSampleGapMs);
    this.lastUpdateAtMs = now;
    this.lastCadenceSpm = cadence;

    this.accumulate(deltaMs, nextState, cadence);
    this.handleStateChange(nextState, now, events);
    this.collectBaseline(nextState, cadence, deltaMs, now, events);
    this.handleContinuity(nextState, now, events);
    this.handleRhythm(nextState, cadence, now, events);

    return this.snapshot(now, events);
  }

  normaliseMovementState(movementState, cadence) {
    if (["running", "walking", "stopped"].includes(movementState)) return movementState;
    if (cadence !== null && cadence >= 130) return "running";
    if (cadence !== null && cadence >= 45) return "walking";
    return "unknown";
  }

  accumulate(deltaMs, state, cadence) {
    if (state === "running") {
      this.runningMs += deltaMs;
      if (cadence === null) return;
      this.measuredRunningMs += deltaMs;
      const threshold = this.baselineCadenceSpm === null
        ? null
        : this.baselineCadenceSpm * (1 - this.config.driftRatio);
      const stable = threshold === null || (cadence !== null && cadence >= threshold);
      if (stable) {
        this.stableRunningMs += deltaMs;
        this.currentStableBlockMs += deltaMs;
        this.longestStableBlockMs = Math.max(this.longestStableBlockMs, this.currentStableBlockMs);
      } else {
        this.currentStableBlockMs = 0;
      }
    } else {
      this.currentStableBlockMs = 0;
      if (state === "walking") this.walkingMs += deltaMs;
      if (state === "stopped") this.stoppedMs += deltaMs;
    }
  }

  handleStateChange(nextState, now, events) {
    if (nextState === this.locomotionState) return;
    const previous = this.locomotionState;
    this.previousLocomotionState = previous;
    this.locomotionState = nextState;
    this.stateSinceMs = now;

    if (nextState !== "walking") {
      this.walkCandidateSinceMs = null;
      this.walkCounted = false;
    }
    if (nextState !== "stopped") {
      this.stopCandidateSinceMs = null;
      this.stopCounted = false;
    }
    if (nextState !== "running") {
      this.driftCandidateSinceMs = null;
      this.recoveryCandidateSinceMs = null;
    }

    if (nextState === "running" && ["walking", "stopped"].includes(previous)) {
      this.lastStatus = this.baselineCadenceSpm === null ? "CALIBRATING" : "RESET";
      this.lastMessage = "Running again. Settle into your natural rhythm.";
      this.pushCue(events, "running-resumed", this.lastMessage, now, { force: true });
    }
  }

  collectBaseline(state, cadence, deltaMs, now, events) {
    if (this.baselineCadenceSpm !== null || state !== "running" || cadence === null || cadence < 120 || cadence > 230) return;
    this.baselineRunningMs += deltaMs;
    if (now - this.lastBaselineSampleAtMs >= this.config.baselineSampleEveryMs) {
      this.baselineSamples.push(cadence);
      this.lastBaselineSampleAtMs = now;
    }
    if (this.baselineRunningMs < this.config.baselineDurationMs || this.baselineSamples.length < this.config.baselineMinSamples) return;

    this.baselineCadenceSpm = Math.round(median(this.baselineSamples));
    this.lastStatus = "STEADY";
    this.lastMessage = `Baseline learned at ${this.baselineCadenceSpm} steps per minute.`;
    this.pushCue(events, "baseline-ready", this.lastMessage, now, { force: true });
  }

  handleContinuity(state, now, events) {
    if (state === "walking") {
      this.walkCandidateSinceMs ??= now;
      const heldMs = now - this.walkCandidateSinceMs;
      if (heldMs >= this.config.walkHoldMs && !this.walkCounted) {
        this.walkCounted = true;
        if (now <= this.excusedUntilMs) {
          this.lastStatus = "PLANNED WALK";
          this.lastMessage = "Planned walk in progress.";
        } else {
          this.unplannedWalks += 1;
          this.lastStatus = "WALKING";
          this.lastMessage = "Unplanned walk detected. Reset calmly when you are ready.";
          this.pushCue(events, "unplanned-walk", this.lastMessage, now, { force: true });
        }
      }
    }

    if (state === "stopped") {
      this.stopCandidateSinceMs ??= now;
      if (now - this.stopCandidateSinceMs >= this.config.stopHoldMs && !this.stopCounted) {
        this.stopCounted = true;
        this.stopCount += 1;
        this.lastStatus = now <= this.excusedUntilMs ? "PLANNED STOP" : "STOPPED";
        this.lastMessage = now <= this.excusedUntilMs ? "Planned stop in progress." : "Run stopped. I will continue when you move again.";
      }
    }
  }

  handleRhythm(state, cadence, now, events) {
    if (this.baselineCadenceSpm === null) {
      if (state === "running") {
        this.lastStatus = "CALIBRATING";
        this.lastMessage = "Learning your natural running rhythm.";
      }
      return;
    }
    if (state !== "running" || cadence === null) return;

    const driftThreshold = this.baselineCadenceSpm * (1 - this.config.driftRatio);
    const recoveryThreshold = this.baselineCadenceSpm * (1 - this.config.recoveryRatio);

    if (!this.driftActive && cadence < driftThreshold) {
      this.driftCandidateSinceMs ??= now;
      if (now - this.driftCandidateSinceMs >= this.config.driftHoldMs) {
        this.driftActive = true;
        this.recoveryCandidateSinceMs = null;
        const change = Math.max(1, Math.round((1 - cadence / this.baselineCadenceSpm) * 100));
        this.lastStatus = "FADING";
        this.lastMessage = `Rhythm is down ${change} percent. Try slightly shorter, quicker steps.`;
        this.pushCue(events, "rhythm-fading", this.lastMessage, now);
      }
      return;
    }

    if (!this.driftActive) {
      this.driftCandidateSinceMs = null;
      this.lastStatus = "STEADY";
      this.lastMessage = "Rhythm is steady.";
      return;
    }

    if (cadence >= recoveryThreshold) {
      this.recoveryCandidateSinceMs ??= now;
      if (now - this.recoveryCandidateSinceMs >= this.config.recoveryHoldMs) {
        this.driftActive = false;
        this.driftCandidateSinceMs = null;
        this.recoveryCandidateSinceMs = null;
        this.lastStatus = "STEADY";
        this.lastMessage = "Good correction. Your rhythm is steady again.";
        this.pushCue(events, "rhythm-recovered", this.lastMessage, now, { force: true });
      }
    } else {
      this.recoveryCandidateSinceMs = null;
      this.lastStatus = "FADING";
    }
  }

  pushCue(events, type, message, now, { force = false } = {}) {
    const cooldownReady = force || now - this.lastCueAtMs >= this.config.cueCooldownMs;
    const speak = cooldownReady && now > this.silencedUntilMs;
    events.push({ type, message, speak });
    if (speak) this.lastCueAtMs = now;
  }

  snapshot(timestampMs = this.lastUpdateAtMs ?? 0, events = []) {
    const stablePercent = this.measuredRunningMs > 0
      ? Math.round(this.stableRunningMs / this.measuredRunningMs * 100)
      : 0;
    const baselineProgress = this.baselineCadenceSpm !== null
      ? 100
      : Math.round(clamp(this.baselineRunningMs / Math.max(1, this.config.baselineDurationMs), 0, 1) * 100);
    return {
      active: this.startedAtMs !== null,
      timestampMs,
      status: this.lastStatus,
      message: this.lastMessage,
      movementState: this.locomotionState,
      cadenceSpm: this.lastCadenceSpm,
      baselineCadenceSpm: this.baselineCadenceSpm,
      baselineProgress,
      driftActive: this.driftActive,
      stablePercent,
      unplannedWalks: this.unplannedWalks,
      stopCount: this.stopCount,
      runningMs: this.runningMs,
      walkingMs: this.walkingMs,
      stoppedMs: this.stoppedMs,
      longestStableBlockMs: this.longestStableBlockMs,
      plannedBreakActive: timestampMs <= this.excusedUntilMs,
      silenced: timestampMs <= this.silencedUntilMs,
      events
    };
  }
}
