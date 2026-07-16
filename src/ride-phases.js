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

export function getLiveChallenge({ reminderRows = [], intervalRemainingSec = 0, intervalElapsedSec = 0 } = {}) {
  const intervalRemaining = Math.max(0, finite(intervalRemainingSec));
  const nextReminder = reminderRows
    .filter(row => Number.isFinite(Number(row?.remaining)))
    .sort((a, b) => Number(a.remaining) - Number(b.remaining))[0];
  const reminderRemaining = nextReminder ? Math.max(0, finite(nextReminder.remaining)) : Infinity;
  // Timers are sampled a few milliseconds apart, so treat targets within one second as simultaneous.
  // This keeps a Water reminder aligned with an equally timed Aero interval instead of flickering labels.
  const usesReminder = Boolean(nextReminder) && reminderRemaining <= intervalRemaining + 1;
  const actionLabels = { water: "Water", fuel: "Fuel", stretch: "Stretch" };
  const label = usesReminder ? `Hold Aero to ${actionLabels[nextReminder.type] || "Next Action"}` : "Complete Aero Interval";
  const remainingSec = usesReminder ? reminderRemaining : intervalRemaining;
  const targetSec = Math.max(1, remainingSec + Math.max(0, finite(intervalElapsedSec)));
  return { label, remainingSec, targetSec, type: usesReminder ? nextReminder.type : "interval" };
}

export function getPersonalBest(history = [], currentBestSec = 0) {
  return Math.max(0, finite(currentBestSec), ...history.map(ride => Math.max(0, finite(ride?.bestIntervalSeconds))));
}

export function getPositionTimes(rideElapsedMs = 0, aeroElapsedMs = 0) {
  const overallMs = Math.floor(Math.max(0, finite(rideElapsedMs)) / 1000) * 1000;
  const aeroMs = Math.floor(clamp(finite(aeroElapsedMs), 0, overallMs) / 1000) * 1000;
  return { overallMs, aeroMs, uprightMs: overallMs - aeroMs };
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
