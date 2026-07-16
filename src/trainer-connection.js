const CYCLING_POWER_SERVICE = "cycling_power";
const CSC_SERVICE = "cycling_speed_and_cadence";
const CYCLING_POWER_MEASUREMENT = "cycling_power_measurement";
const CSC_MEASUREMENT = "csc_measurement";

const asView = value => value instanceof DataView
  ? value
  : new DataView(value.buffer || value, value.byteOffset || 0, value.byteLength);

export function parseCyclingPowerMeasurement(value) {
  const view = asView(value);
  if (view.byteLength < 4) throw new Error("Cycling Power measurement is incomplete.");
  const flags = view.getUint16(0, true);
  let offset = 4;
  const result = { watts: view.getInt16(2, true) };

  if (flags & 0x01) offset += 1;
  if (flags & 0x04) offset += 2;
  if (flags & 0x10) offset += 6;
  if (flags & 0x20) {
    if (view.byteLength >= offset + 4) {
      result.cumulativeCrankRevolutions = view.getUint16(offset, true);
      result.lastCrankEventTime = view.getUint16(offset + 2, true);
    }
  }
  return result;
}

export function parseCscMeasurement(value) {
  const view = asView(value);
  if (view.byteLength < 1) throw new Error("Cadence measurement is incomplete.");
  const flags = view.getUint8(0);
  let offset = 1;
  const result = {};
  if (flags & 0x01) {
    if (view.byteLength < offset + 6) throw new Error("Wheel measurement is incomplete.");
    result.cumulativeWheelRevolutions = view.getUint32(offset, true);
    result.lastWheelEventTime = view.getUint16(offset + 4, true);
    offset += 6;
  }
  if (flags & 0x02) {
    if (view.byteLength < offset + 4) throw new Error("Crank measurement is incomplete.");
    result.cumulativeCrankRevolutions = view.getUint16(offset, true);
    result.lastCrankEventTime = view.getUint16(offset + 2, true);
  }
  return result;
}

export function calculateCadence(previous, current) {
  if (!previous || !current
    || !Number.isFinite(previous.cumulativeCrankRevolutions)
    || !Number.isFinite(current.cumulativeCrankRevolutions)
    || !Number.isFinite(previous.lastCrankEventTime)
    || !Number.isFinite(current.lastCrankEventTime)) return null;
  const revolutions = (current.cumulativeCrankRevolutions - previous.cumulativeCrankRevolutions + 0x10000) % 0x10000;
  const eventTicks = (current.lastCrankEventTime - previous.lastCrankEventTime + 0x10000) % 0x10000;
  if (!eventTicks) return null;
  return Math.max(0, Math.min(300, revolutions * 60 * 1024 / eventTicks));
}

export class PedallingTracker {
  constructor({ stopDelayMs = 3000 } = {}) {
    this.stopDelayMs = stopDelayMs;
    this.reset();
  }

  reset(startedAtMs = null) {
    this.startedAtMs = startedAtMs;
    this.lastPedallingAtMs = null;
    this.stoppedAtMs = null;
    this.stopCount = 0;
    this.completedStoppedMs = 0;
    this.longestStoppedMs = 0;
    this.powerTotal = 0;
    this.powerSamples = 0;
    this.cadenceTotal = 0;
    this.cadenceSamples = 0;
    this.current = { watts: null, cadence: null };
  }

  update({ watts = null, cadence = null, timestampMs = performance.now() } = {}) {
    if (this.startedAtMs === null) this.startedAtMs = timestampMs;
    if (Number.isFinite(watts)) {
      this.current.watts = Math.max(0, watts);
      this.powerTotal += this.current.watts;
      this.powerSamples += 1;
    }
    if (Number.isFinite(cadence)) {
      this.current.cadence = Math.max(0, cadence);
      if (this.current.cadence > 0) {
        this.cadenceTotal += this.current.cadence;
        this.cadenceSamples += 1;
      }
    }
    const pedalling = (Number.isFinite(cadence) && cadence > 0)
      || (!Number.isFinite(cadence) && Number.isFinite(watts) && watts > 5);
    if (pedalling) {
      this.lastPedallingAtMs = timestampMs;
      if (this.stoppedAtMs !== null) this.finishStop(timestampMs);
    }
    return this.tick(timestampMs);
  }

  tick(timestampMs = performance.now()) {
    if (this.lastPedallingAtMs !== null && this.stoppedAtMs === null
      && timestampMs - this.lastPedallingAtMs >= this.stopDelayMs) {
      this.stoppedAtMs = this.lastPedallingAtMs;
      this.stopCount += 1;
      this.current.cadence = 0;
    }
    return this.snapshot(timestampMs);
  }

  pause(timestampMs = performance.now()) {
    if (this.stoppedAtMs !== null) this.finishStop(timestampMs);
    this.lastPedallingAtMs = null;
    this.current.cadence = null;
    return this.snapshot(timestampMs);
  }

  finishStop(timestampMs) {
    const duration = Math.max(0, timestampMs - this.stoppedAtMs);
    this.completedStoppedMs += duration;
    this.longestStoppedMs = Math.max(this.longestStoppedMs, duration);
    this.stoppedAtMs = null;
  }

  snapshot(timestampMs = performance.now()) {
    const activeStopMs = this.stoppedAtMs === null ? 0 : Math.max(0, timestampMs - this.stoppedAtMs);
    return {
      watts: this.current.watts,
      cadence: this.current.cadence,
      stopCount: this.stopCount,
      stoppedMs: this.completedStoppedMs + activeStopMs,
      longestStopMs: Math.max(this.longestStoppedMs, activeStopMs),
      averageWatts: this.powerSamples ? this.powerTotal / this.powerSamples : null,
      averageCadence: this.cadenceSamples ? this.cadenceTotal / this.cadenceSamples : null,
      isStopped: this.stoppedAtMs !== null
    };
  }
}

export class SmartTrainerConnection {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onUpdate = () => {}, onStatus = () => {} } = {}) {
    this.bluetooth = bluetooth;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.device = null;
    this.server = null;
    this.previousCrank = null;
    this.latest = { watts: null, cadence: null };
    this.boundDisconnect = () => this.handleDisconnect();
  }

  get supported() { return Boolean(this.bluetooth?.requestDevice); }
  get connected() { return Boolean(this.device?.gatt?.connected); }

  async connect() {
    if (!this.supported) throw new Error("Bluetooth trainer connections require Chrome or Edge on a Bluetooth-capable device.");
    this.onStatus({ state: "connecting", message: "Wake the trainer by pedalling, then select Tacx Bushido Smart." });
    this.device = await this.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [CYCLING_POWER_SERVICE, CSC_SERVICE]
    });
    this.device.addEventListener("gattserverdisconnected", this.boundDisconnect);
    this.server = await this.device.gatt.connect();
    const subscriptions = [];
    for (const [serviceName, characteristicName, handler] of [
      [CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, event => this.handlePower(event.target.value)],
      [CSC_SERVICE, CSC_MEASUREMENT, event => this.handleCadence(event.target.value)]
    ]) {
      try {
        const service = await this.server.getPrimaryService(serviceName);
        const characteristic = await service.getCharacteristic(characteristicName);
        characteristic.addEventListener("characteristicvaluechanged", handler);
        await characteristic.startNotifications();
        subscriptions.push(serviceName);
      } catch (_) {}
    }
    if (!subscriptions.length) {
      this.disconnect();
      throw new Error("The trainer connected, but did not expose power or cadence data. Keep pedalling and try again.");
    }
    this.onStatus({ state: "connected", message: `${this.device.name || "Tacx Bushido Smart"} connected`, deviceName: this.device.name || "Tacx Bushido Smart" });
    return { deviceName: this.device.name || "Tacx Bushido Smart", services: subscriptions };
  }

  handlePower(value) {
    const measurement = parseCyclingPowerMeasurement(value);
    this.latest.watts = measurement.watts;
    this.updateCrank(measurement);
    this.onUpdate({ ...this.latest, timestampMs: performance.now() });
  }

  handleCadence(value) {
    const measurement = parseCscMeasurement(value);
    this.updateCrank(measurement);
    this.onUpdate({ ...this.latest, timestampMs: performance.now() });
  }

  updateCrank(measurement) {
    if (!Number.isFinite(measurement.cumulativeCrankRevolutions)) return;
    const cadence = calculateCadence(this.previousCrank, measurement);
    this.previousCrank = measurement;
    if (Number.isFinite(cadence)) this.latest.cadence = cadence;
  }

  handleDisconnect() {
    this.server = null;
    this.previousCrank = null;
    this.onStatus({ state: "disconnected", message: "Trainer disconnected. Pedal to wake it, then reconnect." });
  }

  disconnect() {
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.server = null;
    this.previousCrank = null;
    this.latest = { watts: null, cadence: null };
  }
}
