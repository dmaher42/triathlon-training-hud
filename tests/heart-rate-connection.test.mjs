import test from "node:test";
import assert from "node:assert/strict";
import { HeartRateMonitorConnection, HeartRateTracker, parseHeartRateMeasurement } from "../src/heart-rate-connection.js";

test("parses standard 8-bit and 16-bit heart-rate measurements", () => {
  assert.deepEqual(parseHeartRateMeasurement(new Uint8Array([0x00, 148])), { bpm: 148 });
  assert.deepEqual(parseHeartRateMeasurement(new Uint8Array([0x01, 200, 0])), { bpm: 200 });
  assert.throws(() => parseHeartRateMeasurement(new Uint8Array([0x00, 5])), /outside the supported range/);
});

test("tracks current, average, maximum and restored heart rate", () => {
  const tracker = new HeartRateTracker();
  tracker.update({ bpm: 140 });
  const snapshot = tracker.update({ bpm: 160 });
  assert.equal(snapshot.bpm, 160);
  assert.equal(snapshot.averageBpm, 150);
  assert.equal(snapshot.maxBpm, 160);
  assert.equal(snapshot.sampleCount, 2);

  const restored = new HeartRateTracker();
  restored.restore(snapshot);
  const continued = restored.update({ bpm: 150 });
  assert.equal(continued.averageBpm, 150);
  assert.equal(continued.maxBpm, 160);
  assert.equal(continued.sampleCount, 3);
  assert.equal(restored.pause().bpm, null);
});

test("reconnects a remembered heart-rate monitor without reopening the chooser", async () => {
  const listeners = new Map();
  const characteristic = {
    addEventListener() {},
    async startNotifications() { return this; }
  };
  const server = {
    async getPrimaryService(service) {
      assert.equal(service, "heart_rate");
      return {
        async getCharacteristic(characteristicName) {
          assert.equal(characteristicName, "heart_rate_measurement");
          return characteristic;
        }
      };
    }
  };
  let gattConnectCount = 0;
  const device = {
    name: "Test HR strap",
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    gatt: {
      connected: false,
      async connect() { gattConnectCount += 1; this.connected = true; return server; },
      disconnect() { this.connected = false; }
    }
  };
  let chooserCount = 0;
  let requestedOptions = null;
  const statuses = [];
  const connection = new HeartRateMonitorConnection({
    bluetooth: {
      async requestDevice(options) { chooserCount += 1; requestedOptions = options; return device; }
    },
    onStatus: status => statuses.push(status.state)
  });

  await connection.connect();
  device.gatt.connected = false;
  listeners.get("gattserverdisconnected")();
  await connection.reconnect();

  assert.deepEqual(requestedOptions, { filters: [{ services: ["heart_rate"] }] });
  assert.equal(chooserCount, 1);
  assert.equal(gattConnectCount, 2);
  assert.equal(connection.connected, true);
  assert.deepEqual(statuses, ["connecting", "connected", "disconnected", "reconnecting", "connected"]);
});
