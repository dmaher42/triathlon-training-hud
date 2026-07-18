export const RUN_SESSION_VERSION = 1;
export const DEFAULT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

export function createInterruption({ reason, startedAtEpochMs }) {
  return {
    reason: String(reason || "unknown").slice(0, 40),
    startedAtEpochMs: finite(startedAtEpochMs) ?? Date.now(),
    endedAtEpochMs: null
  };
}

export function closeInterruption(interruption, endedAtEpochMs) {
  if (!interruption || interruption.endedAtEpochMs !== null) return interruption;
  return { ...interruption, endedAtEpochMs: Math.max(interruption.startedAtEpochMs, finite(endedAtEpochMs) ?? Date.now()) };
}

export function interruptionSummary(interruptions = [], nowEpochMs = Date.now()) {
  const safeNow = finite(nowEpochMs) ?? Date.now();
  return interruptions.reduce((summary, interruption) => {
    const started = finite(interruption?.startedAtEpochMs);
    if (started === null) return summary;
    const ended = finite(interruption?.endedAtEpochMs) ?? safeNow;
    summary.count += 1;
    summary.totalMs += Math.max(0, ended - started);
    return summary;
  }, { count: 0, totalMs: 0 });
}

export function makePersistedSession({
  startedAtEpochMs,
  savedAtEpochMs = Date.now(),
  coachState,
  formState = null,
  armState = null,
  phonePlacement = "hip",
  pocketSide = "right",
  interruptions = []
}) {
  return {
    version: RUN_SESSION_VERSION,
    active: true,
    startedAtEpochMs: finite(startedAtEpochMs),
    savedAtEpochMs: finite(savedAtEpochMs),
    coachState,
    formState,
    armState,
    phonePlacement: phonePlacement === "hand" ? "hand" : "hip",
    pocketSide: pocketSide === "left" ? "left" : "right",
    interruptions
  };
}

export function parsePersistedSession(raw, { nowEpochMs = Date.now(), maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS } = {}) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || value.version !== RUN_SESSION_VERSION || value.active !== true) return null;
    const startedAtEpochMs = finite(value.startedAtEpochMs);
    const savedAtEpochMs = finite(value.savedAtEpochMs);
    if (startedAtEpochMs === null || savedAtEpochMs === null) return null;
    if (savedAtEpochMs > nowEpochMs + 60_000 || nowEpochMs - savedAtEpochMs > maxAgeMs) return null;
    if (!value.coachState || typeof value.coachState !== "object") return null;
    return {
      ...value,
      startedAtEpochMs,
      savedAtEpochMs,
      phonePlacement: value.phonePlacement === "hand" ? "hand" : "hip",
      pocketSide: value.pocketSide === "left" ? "left" : "right",
      interruptions: Array.isArray(value.interruptions) ? value.interruptions.slice(0, 100) : []
    };
  } catch (_) {
    return null;
  }
}
