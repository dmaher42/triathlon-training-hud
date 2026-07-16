import assert from "node:assert/strict";
import test from "node:test";
import {
  RIDE_SCHEMA_VERSION,
  buildCoachingObservations,
  buildRecommendation,
  calculateActionStats,
  calculateReminderStats,
  completeReminderRecord,
  createCompletedAction,
  createReminder,
  findReminderForAction,
  getActiveReminders,
  isDuplicateAction,
  materializeReminderOccurrences,
  migrateHistory,
  skipReminderRecord,
  snoozeReminderRecord,
  updateCompletedActionReason
} from "../src/habit-learning.js";
import { HISTORY_KEY, SETTINGS_KEY, loadHistory, loadSettings, resetLearningFor, saveRide, saveSettings } from "../src/history-store.js";

class MemoryStorage {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const actionsAt = (type, minutes, startedIso = "2026-01-01T00:00:00.000Z") => minutes.map((minute, index) => createCompletedAction({
  type,
  rideElapsedSec: minute * 60,
  timestampIso: new Date(Date.parse(startedIso) + minute * 60000).toISOString(),
  reason: index % 2 ? "Planned" : null,
  source: "manual",
  posture: "aero",
  aeroIntervalNumber: 1
}));

test("old ride history migrates without inventing action timestamps", () => {
  const oldRide = { startedIso: "2025-01-01T00:00:00.000Z", rideSeconds: 3600, aeroSeconds: 2400, waterCount: 3 };
  const [migrated] = migrateHistory([oldRide]);

  assert.equal(migrated.schemaVersion, RIDE_SCHEMA_VERSION);
  assert.equal(migrated.rideSeconds, 3600);
  assert.deepEqual(migrated.actions, []);
  assert.deepEqual(migrated.reminders, []);
});

test("migration rejects malformed actions instead of inventing hydration data", () => {
  const [migrated] = migrateHistory([{
    startedIso: "2025-01-01T00:00:00.000Z",
    rideSeconds: 3600,
    actions: [
      { type: "unknown", rideElapsedSec: 300 },
      { type: "water", rideElapsedSec: "not-a-time" },
      { type: "water", rideElapsedSec: "" },
      { type: "fuel", rideElapsedSec: 600 }
    ]
  }]);

  assert.equal(migrated.actions.length, 1);
  assert.equal(migrated.actions[0].type, "fuel");
  assert.equal(migrated.actions[0].timestampIso, null);
});

test("canonical actions retain context and reject rapid duplicates", () => {
  const action = createCompletedAction({ type: "water", rideElapsedSec: 600, source: "reminder", reminderId: "r1", posture: "aero", rideState: "aero", aeroIntervalNumber: 2 });
  assert.equal(action.type, "water");
  assert.equal(action.source, "reminder");
  assert.equal(action.aeroIntervalNumber, 2);
  assert.equal(isDuplicateAction([action], "water", 603), true);
  assert.equal(isDuplicateAction([action], "water", 605), false);
});

test("optional reason updates the same action without creating another", () => {
  const actions = [createCompletedAction({ type: "stretch", rideElapsedSec: 700 })];
  const originalId = actions[0].id;
  updateCompletedActionReason(actions, originalId, "Neck");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, originalId);
  assert.equal(actions[0].reason, "Neck");
});

test("action statistics include intervals, consistency, ride change and reasons", () => {
  const actions = actionsAt("water", [10, 20, 30, 45, 60, 75]);
  actions[2].reason = "Thirsty";
  const stats = calculateActionStats(actions, "water", 90 * 60);

  assert.equal(stats.totalActions, 6);
  assert.equal(stats.firstActionSec, 600);
  assert.equal(stats.medianIntervalSec, 900);
  assert.equal(stats.shortestIntervalSec, 600);
  assert.equal(stats.longestIntervalSec, 900);
  assert.equal(stats.reasons.Thirsty, 1);
});

test("action statistics remove rapid duplicates from totals and reasons", () => {
  const actions = actionsAt("water", [10, 10.03, 20]);
  actions[1].reason = "Thirsty";
  const stats = calculateActionStats(actions, "water", 30 * 60);

  assert.equal(stats.totalActions, 2);
  assert.equal(stats.medianIntervalSec, 600);
  assert.equal(stats.reasons.Thirsty, undefined);
});

test("reminder summary preserves done, snoozed, skipped and missed outcomes", () => {
  const done = createReminder({ type: "fuel", dueAtSec: 1200 }); done.status = "done";
  const snoozed = createReminder({ type: "fuel", dueAtSec: 2400 }); snoozed.status = "snoozed"; snoozed.snoozes.push({ atSec: 2400, untilSec: 2700 });
  const skipped = createReminder({ type: "fuel", dueAtSec: 3600 }); skipped.status = "skipped";
  const stats = calculateReminderStats([done, snoozed, skipped], "fuel");

  assert.deepEqual(stats, { planned: 3, completed: 1, skipped: 1, missed: 1, snoozed: 1 });
});

test("overlapping schedules create and preserve every independent reminder", () => {
  const reminders = [];
  const nextDue = { water: 600, fuel: 600, stretch: 600 };
  const created = materializeReminderOccurrences({
    reminders,
    nextDue,
    elapsedSec: 601,
    cadences: { water: 600, fuel: 1200, stretch: 900 },
    sources: { water: "fixed", fuel: "fixed", stretch: "fixed" }
  });
  assert.deepEqual(created.map(item => item.type), ["water", "fuel", "stretch"]);
  assert.equal(getActiveReminders(reminders, 601).length, 3);
});

test("snooze exposes the next reminder and requeues without changing cadence", () => {
  const first = createReminder({ type: "water", dueAtSec: 600 });
  const second = createReminder({ type: "fuel", dueAtSec: 610 });
  const nextDue = { water: 1200, fuel: 1210, stretch: 1800 };
  snoozeReminderRecord(first, 605, 5);
  assert.equal(getActiveReminders([first, second], 611)[0].id, second.id);
  assert.ok(getActiveReminders([first, second], 906).some(reminder => reminder.id === first.id));
  assert.deepEqual(nextDue, { water: 1200, fuel: 1210, stretch: 1800 });
});

test("manual completion selects the currently due occurrence before a future snooze", () => {
  const snoozed = createReminder({ type: "water", dueAtSec: 600 });
  snoozeReminderRecord(snoozed, 600, 5);
  const due = createReminder({ type: "water", dueAtSec: 700 });

  assert.equal(findReminderForAction([snoozed, due], "water", 705).id, due.id);
  assert.equal(findReminderForAction([snoozed, due], "water", 705, snoozed.id).id, snoozed.id);
});

test("Done and Skip resolve only their own reminder occurrence", () => {
  const done = createReminder({ type: "water", dueAtSec: 600 });
  const skipped = createReminder({ type: "water", dueAtSec: 1200 });
  const action = createCompletedAction({ type: "water", rideElapsedSec: 605 });
  assert.equal(completeReminderRecord(done, action, 605), true);
  assert.equal(skipReminderRecord(skipped, 1205), true);
  assert.equal(done.status, "done");
  assert.equal(skipped.status, "skipped");
});

test("Coach Mode with insufficient history refuses to claim a recommendation", () => {
  const recommendation = buildRecommendation([], "water", 3 * 3600);
  assert.equal(recommendation.sufficient, false);
});

test("Coach Mode uses recent similar rides and ignores dissimilar durations", () => {
  const makeRide = (day, durationHours, minutes) => ({
    schemaVersion: 2,
    id: `ride-${day}`,
    startedIso: `2026-02-0${day}T00:00:00.000Z`,
    rideSeconds: durationHours * 3600,
    settings: { plannedRideSec: durationHours * 3600 },
    actions: actionsAt("water", minutes, `2026-02-0${day}T00:00:00.000Z`),
    reminders: []
  });
  const history = [
    makeRide(1, 3, [20, 40, 60, 80]),
    makeRide(2, 3.2, [22, 43, 64, 85]),
    makeRide(3, 2.8, [21, 42, 63, 84]),
    makeRide(4, 1, [5, 10, 15, 20])
  ];
  const recommendation = buildRecommendation(history, "water", 3 * 3600);

  assert.equal(recommendation.sufficient, true);
  assert.equal(recommendation.ridesUsed, 3);
  assert.equal(recommendation.suggestedSec, 1200);
  assert.match(recommendation.explanation, /not an optimal prescription/i);
});

test("history store migrates in place and retains up to fifty rides", () => {
  const storage = new MemoryStorage({ [HISTORY_KEY]: JSON.stringify([{ startedIso: "2025-01-01T00:00:00.000Z", rideSeconds: 100 }]) });
  const loaded = loadHistory(storage);
  assert.equal(loaded[0].schemaVersion, 2);
  const saved = saveRide({ startedIso: "2026-01-01T00:00:00.000Z", rideSeconds: 200 }, storage);
  assert.equal(saved.length, 2);
  assert.equal(JSON.parse(storage.getItem(HISTORY_KEY))[0].schemaVersion, 2);
});

test("post-ride context updates replace the saved ride instead of duplicating it", () => {
  const storage = new MemoryStorage();
  const ride = {
    schemaVersion: RIDE_SCHEMA_VERSION,
    id: "ride-context-update",
    startedIso: "2026-01-01T00:00:00.000Z",
    rideSeconds: 3600,
    actions: [createCompletedAction({ type: "stretch", rideElapsedSec: 1800 })]
  };
  saveRide(ride, storage);
  updateCompletedActionReason(ride.actions, ride.actions[0].id, "Hips");
  saveRide(ride, storage);

  const history = loadHistory(storage);
  assert.equal(history.length, 1);
  assert.equal(history[0].actions[0].reason, "Hips");
});

test("malformed local history fails safely to an empty list", () => {
  const storage = new MemoryStorage({ [HISTORY_KEY]: "{not-json" });
  assert.deepEqual(loadHistory(storage), []);
});

test("per-action learning reset does not delete ride history", () => {
  const storage = new MemoryStorage({
    [HISTORY_KEY]: JSON.stringify([{ startedIso: "2025-01-01T00:00:00.000Z", rideSeconds: 100 }]),
    triHudSettings: JSON.stringify({ acceptedIntervals: { water: { seconds: 1200, source: "history", ridesUsed: 4 } } })
  });
  const settings = resetLearningFor("water", storage);
  assert.ok(settings.learningResetAt.water);
  assert.equal(settings.acceptedIntervals.water.seconds, 1200);
  assert.equal(settings.acceptedIntervals.water.source, "athlete-entered");
  assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)).length, 1);
});

test("dashboard style persists and invalid values fall back to practical", () => {
  const storage = new MemoryStorage();
  const settings = loadSettings(storage);
  assert.equal(settings.dashboardStyle, "practical");
  settings.dashboardStyle = "immersive";
  saveSettings(settings, storage);
  assert.equal(loadSettings(storage).dashboardStyle, "immersive");
  storage.setItem(SETTINGS_KEY, JSON.stringify({ dashboardStyle: "unknown" }));
  assert.equal(loadSettings(storage).dashboardStyle, "practical");
});

test("coaching observations only appear when statistics support them", () => {
  const summary = {
    actionStats: {
      water: { totalActions: 4, consistencyScore: 85, shortestIntervalSec: 1080, longestIntervalSec: 1320, laterRideChange: "stable" },
      fuel: { totalActions: 1 },
      stretch: { totalActions: 4, reasons: { Neck: 3, Planned: 1 } }
    },
    reminderStats: { fuel: { planned: 1, completed: 1 } }
  };
  const observations = buildCoachingObservations(summary);
  assert.ok(observations.some(text => text.includes("consistently")));
  assert.ok(observations.some(text => text.includes("Neck")));
});

test("coaching observations use multiple comparable rides before making history claims", () => {
  const makeRide = (id, offset) => ({
    schemaVersion: 2,
    id,
    startedIso: `2026-03-0${offset + 1}T00:00:00.000Z`,
    rideSeconds: 4 * 3600,
    plannedRideSec: 4 * 3600,
    settings: { plannedRideSec: 4 * 3600 },
    actions: [
      ...actionsAt("water", [20, 40, 60, 80]),
      ...actionsAt("stretch", [185, 210, 235]).map(action => ({ ...action, reason: "Neck" }))
    ],
    reminders: []
  });
  const rides = [makeRide("one", 0), makeRide("two", 1), makeRide("three", 2)];
  const observations = buildCoachingObservations(rides[0], rides.slice(1));

  assert.ok(observations.some(text => text.includes("Across 3 comparable rides")));
  assert.ok(observations.some(text => text.includes("After three hours")));
});
