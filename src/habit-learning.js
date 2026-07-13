export const RIDE_SCHEMA_VERSION = 2;
export const ACTION_TYPES = ["water", "fuel", "stretch"];
export const ACTION_LABELS = { water: "Hydration", fuel: "Fuel", stretch: "Stretch" };
export const ACTION_REASONS = {
  water: ["Planned", "Thirsty", "Dry mouth", "Hot", "Other"],
  fuel: ["Planned", "Hungry", "Low energy", "Stomach settling", "Other"],
  stretch: ["Neck", "Shoulders", "Lower back", "Hips", "Hands", "Perineum", "Planned", "Other"]
};

const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function createId(prefix = "record") {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function isDuplicateAction(actions, type, rideElapsedSec, windowSec = 4) {
  const latest = [...actions].reverse().find(action => action.type === type);
  return Boolean(latest && Math.abs(number(rideElapsedSec) - number(latest.rideElapsedSec)) < windowSec);
}

export function createCompletedAction({ type, rideElapsedSec, timestampIso, reason = null, source = "manual", recordedVia = "manual-button", planned = false, reminderId = null, posture = "unknown", rideState = "unknown", aeroIntervalNumber = null }) {
  if (!ACTION_TYPES.includes(type)) throw new Error(`Unsupported action type: ${type}`);
  return {
    id: createId("action"),
    type,
    rideElapsedSec: Math.max(0, number(rideElapsedSec)),
    timestampIso: timestampIso || new Date().toISOString(),
    reason,
    source,
    recordedVia,
    planned,
    reminderId,
    posture,
    rideState,
    aeroIntervalNumber: Number.isFinite(aeroIntervalNumber) ? aeroIntervalNumber : null
  };
}

export function updateCompletedActionReason(actions, actionId, reason) {
  const action = actions.find(item => item.id === actionId);
  if (!action) return null;
  action.reason = reason || null;
  if (reason === "Planned") action.planned = true;
  return action;
}

export function createReminder({ type, dueAtSec, source = "fixed", intervalSec = null }) {
  if (!ACTION_TYPES.includes(type)) throw new Error(`Unsupported reminder type: ${type}`);
  return {
    id: createId("reminder"),
    type,
    originalDueAtSec: Math.max(0, number(dueAtSec)),
    dueAtSec: Math.max(0, number(dueAtSec)),
    intervalSec: Number.isFinite(intervalSec) ? intervalSec : null,
    source,
    status: "pending",
    createdAtIso: new Date().toISOString(),
    completedAtSec: null,
    completedActionId: null,
    skippedAtSec: null,
    snoozes: []
  };
}

export function materializeReminderOccurrences({ reminders, nextDue, elapsedSec, cadences, sources = {}, enabled = true, maxPerType = 12 }) {
  if (!enabled) return [];
  const created = [];
  for (const type of ACTION_TYPES) {
    let guard = 0;
    while (number(nextDue[type]) <= number(elapsedSec) && guard < maxPerType) {
      const reminder = createReminder({ type, dueAtSec: nextDue[type], intervalSec: cadences[type], source: sources[type] || "fixed" });
      reminders.push(reminder);
      created.push(reminder);
      nextDue[type] += cadences[type];
      guard += 1;
    }
  }
  const priority = { water: 0, fuel: 1, stretch: 2 };
  return created.sort((a, b) => a.dueAtSec - b.dueAtSec || priority[a.type] - priority[b.type]);
}

export function getActiveReminders(reminders, elapsedSec) {
  const priority = { water: 0, fuel: 1, stretch: 2 };
  return reminders
    .filter(reminder => ["pending", "snoozed"].includes(reminder.status) && reminder.dueAtSec <= elapsedSec)
    .sort((a, b) => a.dueAtSec - b.dueAtSec || a.originalDueAtSec - b.originalDueAtSec || priority[a.type] - priority[b.type]);
}

export function findReminderForAction(reminders, type, elapsedSec, reminderId = null) {
  const eligible = reminders
    .filter(reminder => reminder.type === type && ["pending", "snoozed"].includes(reminder.status))
    .sort((a, b) => a.dueAtSec - b.dueAtSec || a.originalDueAtSec - b.originalDueAtSec);
  if (reminderId) return eligible.find(reminder => reminder.id === reminderId) || null;
  return eligible.find(reminder => reminder.dueAtSec <= elapsedSec) || null;
}

export function snoozeReminderRecord(reminder, elapsedSec, minutes = 5) {
  if (!reminder || !["pending", "snoozed"].includes(reminder.status)) return false;
  reminder.status = "snoozed";
  reminder.dueAtSec = elapsedSec + minutes * 60;
  reminder.snoozes ??= [];
  reminder.snoozes.push({ atSec: elapsedSec, untilSec: reminder.dueAtSec });
  return true;
}

export function skipReminderRecord(reminder, elapsedSec) {
  if (!reminder || !["pending", "snoozed"].includes(reminder.status)) return false;
  reminder.status = "skipped";
  reminder.skippedAtSec = elapsedSec;
  return true;
}

export function completeReminderRecord(reminder, action, elapsedSec) {
  if (!reminder || !action || !["pending", "snoozed"].includes(reminder.status)) return false;
  reminder.status = "done";
  reminder.completedAtSec = elapsedSec;
  reminder.completedActionId = action.id;
  return true;
}

export function calculateActionStats(actions, type, rideSeconds = 0) {
  const sorted = actions
    .filter(action => action.type === type && Number.isFinite(Number(action.rideElapsedSec)) && Number(action.rideElapsedSec) >= 0)
    .sort((a, b) => Number(a.rideElapsedSec) - Number(b.rideElapsedSec));
  const relevant = sorted.reduce((accepted, action) => {
    const previous = accepted.at(-1);
    if (!previous || Number(action.rideElapsedSec) - Number(previous.rideElapsedSec) >= 4) accepted.push(action);
    return accepted;
  }, []);
  const times = relevant.map(action => number(action.rideElapsedSec));
  const intervals = times.slice(1).map((time, index) => time - times[index]).filter(interval => interval > 4);
  const mean = average(intervals);
  const intervalMedian = median(intervals);
  const variance = mean && intervals.length ? average(intervals.map(value => (value - mean) ** 2)) : null;
  const coefficientOfVariation = mean && variance !== null ? Math.sqrt(variance) / mean : null;
  const consistencyScore = coefficientOfVariation === null ? null : Math.max(0, Math.round((1 - Math.min(1, coefficientOfVariation)) * 100));
  const consistencyLabel = consistencyScore === null ? "Not enough data" : consistencyScore >= 80 ? "Consistent" : consistencyScore >= 60 ? "Moderately consistent" : "Variable";
  const midpoint = number(rideSeconds) / 2;
  const earlyIntervals = intervals.filter((_, index) => times[index + 1] <= midpoint);
  const lateIntervals = intervals.filter((_, index) => times[index + 1] > midpoint);
  const earlyMedian = median(earlyIntervals);
  const lateMedian = median(lateIntervals);
  let laterRideChange = "not-enough-data";
  let laterRideChangePercent = null;
  if (earlyMedian && lateMedian && earlyIntervals.length >= 2 && lateIntervals.length >= 2) {
    laterRideChangePercent = Math.round((lateMedian - earlyMedian) / earlyMedian * 100);
    laterRideChange = Math.abs(laterRideChangePercent) < 20 ? "stable" : laterRideChangePercent > 0 ? "longer" : "shorter";
  }
  const reasons = {};
  for (const action of relevant) if (action.reason) reasons[action.reason] = (reasons[action.reason] || 0) + 1;
  return {
    type,
    totalActions: relevant.length,
    firstActionSec: times[0] ?? null,
    finalActionSec: times.at(-1) ?? null,
    intervalsSec: intervals,
    averageIntervalSec: mean,
    medianIntervalSec: intervalMedian,
    shortestIntervalSec: intervals.length ? Math.min(...intervals) : null,
    longestIntervalSec: intervals.length ? Math.max(...intervals) : null,
    consistencyScore,
    consistencyLabel,
    laterRideChange,
    laterRideChangePercent,
    reasons
  };
}

export function calculateReminderStats(reminders, type) {
  const relevant = reminders.filter(reminder => reminder.type === type);
  return {
    planned: relevant.length,
    completed: relevant.filter(reminder => reminder.status === "done").length,
    skipped: relevant.filter(reminder => reminder.status === "skipped").length,
    missed: relevant.filter(reminder => ["pending", "snoozed", "missed"].includes(reminder.status)).length,
    snoozed: relevant.reduce((sum, reminder) => sum + (reminder.snoozes?.length || 0), 0)
  };
}

export function migrateRideRecord(record = {}) {
  const incomingVersion = number(record.schemaVersion);
  if (incomingVersion > RIDE_SCHEMA_VERSION) return { ...record, learningExcluded: true };
  const actions = Array.isArray(record.actions) ? record.actions.flatMap(action => {
    const rawElapsed = action?.rideElapsedSec ?? action?.at;
    if (rawElapsed === null || rawElapsed === undefined || (typeof rawElapsed === "string" && !rawElapsed.trim())) return [];
    const elapsed = Number(rawElapsed);
    if (!action || !ACTION_TYPES.includes(action.type) || !Number.isFinite(elapsed) || elapsed < 0) return [];
    return [{
      id: action.id || createId("legacy-action"),
      type: action.type,
      rideElapsedSec: elapsed,
      timestampIso: typeof action.timestampIso === "string" ? action.timestampIso : null,
      reason: action.reason || null,
      source: action.source || "manual",
      recordedVia: action.recordedVia || "legacy",
      planned: Boolean(action.planned),
      reminderId: action.reminderId || null,
      posture: action.posture || "unknown",
      rideState: action.rideState || "unknown",
      aeroIntervalNumber: Number.isFinite(action.aeroIntervalNumber) ? action.aeroIntervalNumber : null
    }];
  }) : [];
  const reminders = Array.isArray(record.reminders) ? record.reminders.filter(reminder => ACTION_TYPES.includes(reminder?.type)).map(reminder => ({
    ...reminder,
    id: reminder.id || createId("legacy-reminder"),
    status: reminder.status || "missed",
    snoozes: Array.isArray(reminder.snoozes) ? reminder.snoozes : []
  })) : [];
  const rideSeconds = number(record.rideSeconds);
  const actionStats = Object.fromEntries(ACTION_TYPES.map(type => [type, calculateActionStats(actions, type, rideSeconds)]));
  const reminderStats = Object.fromEntries(ACTION_TYPES.map(type => [type, calculateReminderStats(reminders, type)]));
  return {
    ...record,
    schemaVersion: RIDE_SCHEMA_VERSION,
    id: record.id || `ride-${record.startedIso || Date.now()}`,
    mode: ["fixed", "observation", "coach"].includes(record.mode) ? record.mode : "fixed",
    settings: record.settings || {},
    acceptedRecommendations: record.acceptedRecommendations || {},
    actions,
    reminders,
    actionStats,
    reminderStats,
    coachingObservations: Array.isArray(record.coachingObservations) ? record.coachingObservations : [],
    ...(incomingVersion < RIDE_SCHEMA_VERSION ? { legacy: {
      migratedFrom: incomingVersion,
      actionDetailsUnavailable: !actions.length,
      counts: { water: number(record.waterCount), fuel: number(record.fuelCount), stretch: number(record.stretchCount) }
    } } : {})
  };
}

export function migrateHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.filter(record => record && typeof record === "object").map(migrateRideRecord);
}

function actionIntervalsForRide(ride, type) {
  const stats = ride.actionStats?.[type] || calculateActionStats(ride.actions || [], type, ride.rideSeconds);
  return stats.intervalsSec || [];
}

export function buildRecommendation(history, type, plannedRideSec, resetAtIso = null) {
  const resetAt = resetAtIso ? Date.parse(resetAtIso) : 0;
  const similar = migrateHistory(history)
    .filter(ride => ride.schemaVersion === RIDE_SCHEMA_VERSION && !ride.learningExcluded && !ride.legacy?.actionDetailsUnavailable)
    .filter(ride => !resetAt || Date.parse(ride.startedIso || 0) > resetAt)
    .filter(ride => {
      const duration = number(ride.settings?.plannedRideSec || ride.rideSeconds);
      return duration > 0 && duration >= plannedRideSec * .7 && duration <= plannedRideSec * 1.3 && actionIntervalsForRide(ride, type).length;
    })
    .sort((a, b) => Date.parse(b.startedIso || 0) - Date.parse(a.startedIso || 0))
    .slice(0, 5);
  const perRideMedians = similar.map(ride => median(actionIntervalsForRide(ride, type))).filter(Number.isFinite);
  const totalIntervals = similar.reduce((sum, ride) => sum + actionIntervalsForRide(ride, type).length, 0);
  if (similar.length < 3 || totalIntervals < 8 || perRideMedians.length < 3) {
    return { type, sufficient: false, ridesUsed: similar.length, intervalsUsed: totalIntervals, reason: `Needs at least 3 similar rides and 8 valid intervals.` };
  }
  const weighted = perRideMedians.map((value, index) => ({ value, weight: 1 - index * .12 }));
  const weightedObserved = weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / weighted.reduce((sum, item) => sum + item.weight, 0);
  const observedMedianSec = median(perRideMedians);
  const suggestedSec = Math.max(300, Math.round(weightedObserved / 300) * 300);
  return {
    type,
    sufficient: true,
    ridesUsed: similar.length,
    intervalsUsed: totalIntervals,
    observedMedianSec,
    suggestedSec,
    source: "history",
    explanation: `Across ${similar.length} recent rides of similar duration, your observed median ${ACTION_LABELS[type].toLowerCase()} interval was ${Math.round(observedMedianSec / 60)} minutes. A ${Math.round(suggestedSec / 60)}-minute reminder is an editable starting point, not an optimal prescription.`
  };
}

export function buildRecommendations(history, plannedRideSec, resetAt = {}) {
  return Object.fromEntries(ACTION_TYPES.map(type => [type, buildRecommendation(history, type, plannedRideSec, resetAt[type])]));
}

export function buildCoachingObservations(summary, history = []) {
  const observations = [];
  const historyObservations = [];
  for (const type of ACTION_TYPES) {
    const stats = summary.actionStats?.[type];
    if (!stats || stats.totalActions < 3) continue;
    if (stats.laterRideChange === "longer") observations.push(`Your ${ACTION_LABELS[type].toLowerCase()} intervals became less frequent later in this ride.`);
    if (stats.laterRideChange === "shorter") observations.push(`Your ${ACTION_LABELS[type].toLowerCase()} intervals became more frequent later in this ride.`);
    if (type === "water" && stats.consistencyScore >= 80 && stats.shortestIntervalSec && stats.longestIntervalSec) {
      observations.push(`You drank consistently between ${Math.round(stats.shortestIntervalSec / 60)} and ${Math.round(stats.longestIntervalSec / 60)} minutes.`);
    }
  }
  const stretchStats = summary.actionStats?.stretch;
  if (stretchStats?.totalActions >= 3) {
    const topReason = Object.entries(stretchStats.reasons || {}).sort((a, b) => b[1] - a[1])[0];
    if (topReason && topReason[1] / stretchStats.totalActions >= .5 && topReason[0] !== "Planned") {
      observations.push(`${topReason[0]} was selected for ${topReason[1]} of ${stretchStats.totalActions} stretch actions.`);
    }
  }
  const fuelReminder = summary.reminderStats?.fuel;
  if (fuelReminder && fuelReminder.planned >= 2 && fuelReminder.completed / fuelReminder.planned < .6) {
    observations.push(`Fewer than 60% of planned fuel reminders were completed. Review the timing rather than treating this as a medical recommendation.`);
  }

  const plannedRideSec = number(summary.settings?.plannedRideSec || summary.plannedRideSec || summary.rideSeconds);
  const comparable = [summary, ...migrateHistory(history)]
    .filter((ride, index, rides) => rides.findIndex(candidate => candidate.id && candidate.id === ride.id) === index)
    .filter(ride => !ride.learningExcluded && !ride.legacy?.actionDetailsUnavailable)
    .filter(ride => {
      const duration = number(ride.settings?.plannedRideSec || ride.plannedRideSec || ride.rideSeconds);
      return plannedRideSec > 0 && duration >= plannedRideSec * .7 && duration <= plannedRideSec * 1.3;
    })
    .sort((a, b) => Date.parse(b.startedIso || 0) - Date.parse(a.startedIso || 0))
    .slice(0, 5);

  if (comparable.length >= 3) {
    for (const type of ACTION_TYPES) {
      const medians = comparable
        .map(ride => ride.actionStats?.[type]?.medianIntervalSec ?? calculateActionStats(ride.actions || [], type, ride.rideSeconds).medianIntervalSec)
        .filter(Number.isFinite);
      if (medians.length >= 3) {
        historyObservations.push(`Across ${medians.length} comparable rides with usable intervals, your recorded ${ACTION_LABELS[type].toLowerCase()} actions were typically about ${Math.round(median(medians) / 60)} minutes apart.`);
      }
    }

    const lateStretchReasons = {};
    for (const ride of comparable) {
      for (const action of ride.actions || []) {
        if (action.type === "stretch" && action.reason && action.reason !== "Planned" && number(action.rideElapsedSec) >= 3 * 3600) {
          lateStretchReasons[action.reason] ??= { count: 0, rideIds: new Set() };
          lateStretchReasons[action.reason].count += 1;
          lateStretchReasons[action.reason].rideIds.add(ride.id || ride.startedIso);
        }
      }
    }
    const topLateReason = Object.entries(lateStretchReasons).sort((a, b) => b[1].count - a[1].count)[0];
    if (topLateReason?.[1].rideIds.size >= 3) {
      historyObservations.unshift(`After three hours, ${topLateReason[0].toLowerCase()} was your most frequently recorded stretch reason (${topLateReason[1].count} actions across ${topLateReason[1].rideIds.size} comparable rides).`);
    }
  }

  const combined = historyObservations.length
    ? [...observations.slice(0, 3), ...historyObservations.slice(0, 2)]
    : observations;
  return [...new Set(combined)].slice(0, 5);
}
