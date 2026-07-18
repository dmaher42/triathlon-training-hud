import { ACTION_TYPES, migrateHistory, migrateRideRecord } from "./habit-learning.js";

export const HISTORY_KEY = "triHudHistory";
export const SETTINGS_KEY = "triHudSettings";
export const ACTIVE_RIDE_KEY = "triHudActiveRide";

export function loadHistory(storage = localStorage) {
  let parsed = [];
  try { parsed = JSON.parse(storage.getItem(HISTORY_KEY) || "[]"); } catch (_) {}
  const migrated = migrateHistory(parsed);
  try { storage.setItem(HISTORY_KEY, JSON.stringify(migrated)); } catch (_) {}
  return migrated;
}

export function saveRide(summary, storage = localStorage) {
  const ride = migrateRideRecord(summary);
  const history = loadHistory(storage).filter(item => item.id !== ride.id);
  const next = [ride, ...history].slice(0, 50);
  storage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function loadSettings(storage = localStorage) {
  let parsed = {};
  try { parsed = JSON.parse(storage.getItem(SETTINGS_KEY) || "{}"); } catch (_) {}
  return {
    preferredMode: ["fixed", "observation", "coach"].includes(parsed.preferredMode) ? parsed.preferredMode : "fixed",
    dashboardStyle: ["practical", "immersive"].includes(parsed.dashboardStyle) ? parsed.dashboardStyle : "practical",
    observationReminders: Boolean(parsed.observationReminders),
    acceptedIntervals: parsed.acceptedIntervals || {},
    learningResetAt: Object.fromEntries(ACTION_TYPES.map(type => [type, parsed.learningResetAt?.[type] || null]))
  };
}

export function saveSettings(settings, storage = localStorage) {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

export function loadActiveRide(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(ACTIVE_RIDE_KEY) || "null");
    return parsed?.version === 1 && parsed.rideStartedIso && parsed.model && parsed.timing ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function saveActiveRide(snapshot, storage = localStorage) {
  storage.setItem(ACTIVE_RIDE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export function clearActiveRide(storage = localStorage) {
  storage.removeItem(ACTIVE_RIDE_KEY);
}

export function resetLearningFor(type, storage = localStorage) {
  const settings = loadSettings(storage);
  settings.learningResetAt[type] = new Date().toISOString();
  if (settings.acceptedIntervals[type]) settings.acceptedIntervals[type] = {
    ...settings.acceptedIntervals[type],
    source: "athlete-entered",
    ridesUsed: 0,
    acceptedAtIso: null
  };
  saveSettings(settings, storage);
  return settings;
}
