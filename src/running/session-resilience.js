export const RUN_SESSION_VERSION = 2;
export const COMPLETED_RUN_VERSION = 5;
export const DEFAULT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const mechanicsMetricKeys = new Set([
  "hipVerticalIndex", "hipHorizontalIndex", "hipRotationIndex", "hipImpactVariationIndex",
  "armCycleRpm", "armRegularityPercent", "armRangeIndex"
]);

const finite = value => {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const withoutLegacyMechanics = values => Object.fromEntries(
  Object.entries(values || {}).filter(([key]) => !mechanicsMetricKeys.has(key))
);

const sanitiseLegacySummary = summary => {
  if (!summary || typeof summary !== "object") return summary;
  return {
    ...summary,
    metrics: withoutLegacyMechanics(summary.metrics),
    metricCoveragePercent: withoutLegacyMechanics(summary.metricCoveragePercent),
    warnings: [...new Set([...(summary.warnings || []), "mechanics-history-upgrading"])]
  };
};

const sanitiseLegacyComparison = comparison => {
  if (!comparison || typeof comparison !== "object") return comparison;
  return {
    ...comparison,
    before: sanitiseLegacySummary(comparison.before),
    after: sanitiseLegacySummary(comparison.after),
    previous: sanitiseLegacySummary(comparison.previous),
    last: sanitiseLegacySummary(comparison.last),
    changes: withoutLegacyMechanics(comparison.changes),
    warnings: [...new Set([...(comparison.warnings || []), "mechanics-history-upgrading"])],
    quality: "low"
  };
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

export function resumeTechniqueElapsed({
  savedElapsedMs = 0,
  savedAtEpochMs,
  nowEpochMs = Date.now()
} = {}) {
  const saved = Math.max(0, finite(savedElapsedMs) ?? 0);
  const savedAt = finite(savedAtEpochMs) ?? nowEpochMs;
  const now = finite(nowEpochMs) ?? savedAt;
  const offlineMs = Math.max(0, now - savedAt);
  return Math.max(saved, Math.floor((saved + offlineMs) / 1_000) * 1_000);
}

export function makePersistedSession({
  startedAtEpochMs,
  savedAtEpochMs = Date.now(),
  coachState,
  formState = null,
  armState = null,
  phonePlacement = "hip",
  pocketSide = "right",
  interruptions = [],
  techniqueState = null,
  terrain = "unlabelled",
  comparisonWindowMs = 5 * 60_000,
  retrospectiveComparison = null
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
    interruptions,
    techniqueState: techniqueState && typeof techniqueState === "object" ? techniqueState : null,
    terrain: String(terrain || "unlabelled").slice(0, 24),
    comparisonWindowMs: Math.max(60_000, finite(comparisonWindowMs) ?? 5 * 60_000),
    retrospectiveComparison: retrospectiveComparison && typeof retrospectiveComparison === "object"
      ? retrospectiveComparison
      : null
  };
}

export function parsePersistedSession(raw, { nowEpochMs = Date.now(), maxAgeMs = DEFAULT_SESSION_MAX_AGE_MS } = {}) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || ![1, RUN_SESSION_VERSION].includes(value.version) || value.active !== true) return null;
    const startedAtEpochMs = finite(value.startedAtEpochMs);
    const savedAtEpochMs = finite(value.savedAtEpochMs);
    if (startedAtEpochMs === null || savedAtEpochMs === null) return null;
    if (savedAtEpochMs > nowEpochMs + 60_000 || nowEpochMs - savedAtEpochMs > maxAgeMs) return null;
    if (!value.coachState || typeof value.coachState !== "object") return null;
    const techniqueState = value.techniqueState && typeof value.techniqueState === "object"
      ? value.techniqueState
      : null;
    const retrospectiveComparison = value.retrospectiveComparison && typeof value.retrospectiveComparison === "object"
      ? techniqueState?.version === 1
        ? sanitiseLegacyComparison(value.retrospectiveComparison)
        : value.retrospectiveComparison
      : null;
    return {
      ...value,
      startedAtEpochMs,
      savedAtEpochMs,
      phonePlacement: value.phonePlacement === "hand" ? "hand" : "hip",
      pocketSide: value.pocketSide === "left" ? "left" : "right",
      interruptions: Array.isArray(value.interruptions) ? value.interruptions.slice(0, 100) : [],
      techniqueState,
      terrain: String(value.terrain || "unlabelled").slice(0, 24),
      comparisonWindowMs: Math.max(60_000, finite(value.comparisonWindowMs) ?? 5 * 60_000),
      retrospectiveComparison
    };
  } catch (_) {
    return null;
  }
}

export function makeCompletedRun({
  completedAtEpochMs = Date.now(),
  elapsedMs = 0,
  runSnapshot,
  motionSnapshot,
  phonePlacement = "hip",
  pocketSide = "right",
  placementSwitchCount = 0,
  interruptions = [],
  techniqueComparisons = [],
  terrainSegments = [],
  comparisonWindowMs = 5 * 60_000,
  retrospectiveComparison = null
}) {
  return {
    version: COMPLETED_RUN_VERSION,
    completedAtEpochMs: finite(completedAtEpochMs),
    elapsedMs: Math.max(0, finite(elapsedMs) ?? 0),
    runSnapshot: runSnapshot && typeof runSnapshot === "object"
      ? { ...runSnapshot, events: [] }
      : null,
    snapshot: motionSnapshot && typeof motionSnapshot === "object" ? motionSnapshot : null,
    phonePlacement: phonePlacement === "hand" ? "hand" : "hip",
    pocketSide: pocketSide === "left" ? "left" : "right",
    placementSwitchCount: Math.max(0, Math.floor(finite(placementSwitchCount) ?? 0)),
    interruptions: Array.isArray(interruptions) ? interruptions.slice(0, 100) : [],
    techniqueComparisons: Array.isArray(techniqueComparisons) ? techniqueComparisons.slice(0, 50) : [],
    terrainSegments: Array.isArray(terrainSegments) ? terrainSegments.slice(0, 200) : [],
    comparisonWindowMs: Math.max(60_000, finite(comparisonWindowMs) ?? 5 * 60_000),
    retrospectiveComparison: retrospectiveComparison && typeof retrospectiveComparison === "object"
      ? retrospectiveComparison
      : null
  };
}

export function parseCompletedRun(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || ![1, 2, 3, 4, COMPLETED_RUN_VERSION].includes(value.version)) return null;
    const completedAtEpochMs = finite(value.completedAtEpochMs);
    if (completedAtEpochMs === null || !value.snapshot || typeof value.snapshot !== "object") return null;

    const phonePlacement = value.version >= 2 && value.phonePlacement === "hand" ? "hand" : "hip";
    const base = {
      ...value,
      completedAtEpochMs,
      phonePlacement,
      pocketSide: value.pocketSide === "left" ? "left" : "right",
      placementSwitchCount: Math.max(0, Math.floor(finite(value.placementSwitchCount) ?? 0))
    };

    if (value.version < 3) return base;
    if (!value.runSnapshot || typeof value.runSnapshot !== "object") return null;
    const elapsedMs = finite(value.elapsedMs);
    if (elapsedMs === null || elapsedMs < 0) return null;
    return {
      ...base,
      elapsedMs,
      runSnapshot: { ...value.runSnapshot, events: [] },
      interruptions: Array.isArray(value.interruptions) ? value.interruptions.slice(0, 100) : [],
      techniqueComparisons: Array.isArray(value.techniqueComparisons)
        ? value.techniqueComparisons.slice(0, 50).map(comparison => (
            value.version === 4 ? sanitiseLegacyComparison(comparison) : comparison
          ))
        : [],
      terrainSegments: Array.isArray(value.terrainSegments) ? value.terrainSegments.slice(0, 200) : [],
      comparisonWindowMs: Math.max(60_000, finite(value.comparisonWindowMs) ?? 5 * 60_000),
      retrospectiveComparison: value.retrospectiveComparison && typeof value.retrospectiveComparison === "object"
        ? value.version === 4
          ? sanitiseLegacyComparison(value.retrospectiveComparison)
          : value.retrospectiveComparison
        : null
    };
  } catch (_) {
    return null;
  }
}
