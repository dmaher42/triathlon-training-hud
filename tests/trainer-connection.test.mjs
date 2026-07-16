import test from "node:test";
import assert from "node:assert/strict";
import { PedallingTracker, calculateCadence, parseCscMeasurement, parseCyclingPowerMeasurement } from "../src/trainer-connection.js";

test("parses instantaneous power and crank data", () => {
  const bytes = new Uint8Array([0x20, 0x00, 0xfa, 0x00, 0x2a, 0x00, 0x00, 0x04]);
  assert.deepEqual(parseCyclingPowerMeasurement(new DataView(bytes.buffer)), {
    watts: 250,
    cumulativeCrankRevolutions: 42,
    lastCrankEventTime: 1024
  });
});

test("parses CSC crank data with and without wheel data", () => {
  const crankOnly = new Uint8Array([0x02, 0x10, 0x00, 0x00, 0x08]);
  assert.deepEqual(parseCscMeasurement(new DataView(crankOnly.buffer)), {
    cumulativeCrankRevolutions: 16,
    lastCrankEventTime: 2048
  });
  const both = new Uint8Array([0x03, 0x64, 0, 0, 0, 0, 4, 0x11, 0, 0, 12]);
  assert.deepEqual(parseCscMeasurement(new DataView(both.buffer)), {
    cumulativeWheelRevolutions: 100,
    lastWheelEventTime: 1024,
    cumulativeCrankRevolutions: 17,
    lastCrankEventTime: 3072
  });
});

test("calculates cadence and handles Bluetooth counter rollover", () => {
  assert.equal(calculateCadence(
    { cumulativeCrankRevolutions: 10, lastCrankEventTime: 1000 },
    { cumulativeCrankRevolutions: 11, lastCrankEventTime: 2024 }
  ), 60);
  assert.equal(calculateCadence(
    { cumulativeCrankRevolutions: 65535, lastCrankEventTime: 65024 },
    { cumulativeCrankRevolutions: 0, lastCrankEventTime: 512 }
  ), 60);
});

test("requires three seconds before counting a stop", () => {
  const tracker = new PedallingTracker({ stopDelayMs: 3000 });
  tracker.update({ cadence: 90, watts: 220, timestampMs: 1000 });
  assert.equal(tracker.tick(3999).stopCount, 0);
  const stopped = tracker.tick(4000);
  assert.equal(stopped.stopCount, 1);
  assert.equal(stopped.stoppedMs, 3000);
  assert.equal(stopped.isStopped, true);
  const resumed = tracker.update({ cadence: 88, watts: 210, timestampMs: 6000 });
  assert.equal(resumed.stopCount, 1);
  assert.equal(resumed.stoppedMs, 5000);
  assert.equal(resumed.longestStopMs, 5000);
  assert.equal(resumed.isStopped, false);
});

test("does not count the period before the first cadence movement", () => {
  const tracker = new PedallingTracker({ stopDelayMs: 3000 });
  tracker.reset(0);
  assert.equal(tracker.tick(10000).stopCount, 0);
});

test("uses power as a pedalling fallback when cadence is unavailable", () => {
  const tracker = new PedallingTracker({ stopDelayMs: 3000 });
  tracker.update({ watts: 180, timestampMs: 1000 });
  assert.equal(tracker.tick(3999).stopCount, 0);
  assert.equal(tracker.tick(4000).stopCount, 1);
  assert.equal(tracker.snapshot(4000).averageCadence, null);
});
