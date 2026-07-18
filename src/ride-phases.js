export const RIDE_PHASES = [
  { name: "Warm Up", shortName: "Warm Up" },
  { name: "Build", shortName: "Build" },
  { name: "Race Rhythm", shortName: "Race Rhythm" },
  { name: "Pressure Test", shortName: "Test" },
  { name: "Finish Strong", shortName: "Finish" }
];

const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function getRidePhase(elapsedSec, plannedSec, phases = RIDE_PHASES) {
  const safePhases = phases.length ? phases : RIDE_PHASES;
  const duration = Math.max(1, finite(plannedSec));
  const progress = clamp(finite(elapsedSec) / duration, 0, 1);
  const index = Math.min(safePhases.length - 1, Math.floor(progress * safePhases.length));
  const phaseStart = index / safePhases.length;
  const phaseEnd = (index + 1) / safePhases.length;
  const phaseProgress = phaseEnd === phaseStart ? 1 : clamp((progress - phaseStart) / (phaseEnd - phaseStart), 0, 1);
  return { ...safePhases[index], index, number: index + 1, count: safePhases.length, progress, phaseProgress };
}

export function getLiveChallenge({ intervalRemainingSec = 0, intervalElapsedSec = 0 } = {}) {
  const intervalRemaining = Math.max(0, finite(intervalRemainingSec));
  const targetSec = Math.max(1, intervalRemaining + Math.max(0, finite(intervalElapsedSec)));
  return { label: "Complete Aero Interval", remainingSec: intervalRemaining, targetSec, type: "interval" };
}

export function getLiveCameraAeroStreakMs({
  nowMs = 0,
  cameraEnabled = false,
  positionAeroActive = false,
  streakStartedAt = 0
} = {}) {
  if (!cameraEnabled || !positionAeroActive || finite(streakStartedAt) <= 0) return 0;
  return Math.max(0, finite(nowMs) - finite(streakStartedAt));
}

export function getLongestCameraAeroStreak(events = [], rideSeconds = 0) {
  let activeAtSec = null;
  let bestSec = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const at = Number(event?.at);
    if (!Number.isFinite(at) || at < 0) continue;
    if (event.type === "aero-position-start" && event.source === "camera") {
      if (activeAtSec === null) activeAtSec = at;
      continue;
    }
    if (activeAtSec !== null && ["aero-position-stop", "ride-recovered"].includes(event.type)) {
      bestSec = Math.max(bestSec, at - activeAtSec);
      activeAtSec = null;
    }
  }
  if (activeAtSec !== null) bestSec = Math.max(bestSec, Math.max(0, finite(rideSeconds) - activeAtSec));
  return Math.max(0, bestSec);
}

export function getPersonalBest(history = [], currentBestSec = 0) {
  const savedBests = (Array.isArray(history) ? history : []).map(ride => {
    const explicit = Number(ride?.bestAeroStreakSeconds);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    const hasCameraEvents = Array.isArray(ride?.events)
      && ride.events.some(event => event?.type === "aero-position-start" && event?.source === "camera");
    if (!ride?.camera?.enabled && !hasCameraEvents) return 0;
    return getLongestCameraAeroStreak(ride.events, ride.rideSeconds);
  });
  return Math.max(0, finite(currentBestSec), ...savedBests);
}

export function getPositionTimes(rideElapsedMs = 0, aeroElapsedMs = 0) {
  const overallMs = Math.floor(Math.max(0, finite(rideElapsedMs)) / 1000) * 1000;
  const aeroMs = Math.floor(clamp(finite(aeroElapsedMs), 0, overallMs) / 1000) * 1000;
  return { overallMs, aeroMs, uprightMs: overallMs - aeroMs };
}

export function getLiveAeroDurations({
  nowMs = 0,
  rideState = "paused",
  positionAeroActive = null,
  intervalActive = null,
  aeroSegmentStartedAt = 0,
  intervalSegmentStartedAt = 0,
  intervalAccumulatedMs = 0,
  intervalTargetSec = 0,
  intervalFrozen = false
} = {}) {
  const timestamp = Math.max(0, finite(nowMs));
  const postureActive = positionAeroActive === null ? rideState === "aero" : Boolean(positionAeroActive);
  const clockActive = intervalActive === null ? rideState === "aero" : Boolean(intervalActive);
  const postureMs = postureActive && finite(aeroSegmentStartedAt) > 0
    ? Math.max(0, timestamp - finite(aeroSegmentStartedAt))
    : 0;
  const intervalRemainingMs = Math.max(0, finite(intervalTargetSec) * 1000 - finite(intervalAccumulatedMs));
  const intervalMs = clockActive && !intervalFrozen && finite(intervalSegmentStartedAt) > 0
    ? Math.min(Math.max(0, timestamp - finite(intervalSegmentStartedAt)), intervalRemainingMs)
    : 0;
  return { postureMs, intervalMs };
}

export function getPlanStatus(reminders = [], completedActions = [], toleranceSec = 120) {
  const completed = reminders.filter(reminder => reminder?.status === "done" && Number.isFinite(Number(reminder.completedAtSec)));
  const onTime = completed.filter(reminder => Number(reminder.completedAtSec) - Number(reminder.originalDueAtSec ?? reminder.dueAtSec) <= toleranceSec).length;
  const offPlan = reminders.filter(reminder => ["skipped", "missed"].includes(reminder?.status)).length
    + Math.max(0, completed.length - onTime);
  if (offPlan) return { tone: "attention", text: `${offPlan} ACTION${offPlan === 1 ? "" : "S"} NEED REVIEW` };
  if (onTime) return { tone: "on-plan", text: `ON PLAN • ${onTime} ACTION${onTime === 1 ? "" : "S"} ON TIME` };
  if (completedActions.length) return { tone: "on-plan", text: `ON PLAN • ${completedActions.length} ACTION${completedActions.length === 1 ? "" : "S"} RECORDED` };
  return { tone: "ready", text: "ON PLAN • READY" };
}
