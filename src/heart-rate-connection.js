const HEART_RATE_SERVICE = "heart_rate";
const HEART_RATE_MEASUREMENT = "heart_rate_measurement";

const asView = value => value instanceof DataView
  ? value
  : new DataView(value.buffer || value, value.byteOffset || 0, value.byteLength);

export function parseHeartRateMeasurement(value) {
  const view = asView(value);
  if (view.byteLength < 2) throw new Error("Heart-rate measurement is incomplete.");
  const usesUint16 = Boolean(view.getUint8(0) & 0x01);
  if (usesUint16 && view.byteLength < 3) throw new Error("Heart-rate measurement is incomplete.");
  const bpm = usesUint16 ? view.getUint16(1, true) : view.getUint8(1);
  if (bpm < 20 || bpm > 260) throw new Error("Heart-rate measurement is outside the supported range.");
  return { bpm };
}

export class HeartRateTracker {
  constructor() { this.reset(); }

  reset() {
    this.currentBpm = null;
    this.totalBpm = 0;
    this.sampleCount = 0;
    this.maxBpm = null;
  }

  restore(snapshot = {}) {
    this.reset();
    const averageBpm = Number(snapshot.averageBpm);
    const sampleCount = Math.max(0, Math.floor(Number(snapshot.sampleCount) || 0));
    if (Number.isFinite(averageBpm) && sampleCount) {
      this.totalBpm = averageBpm * sampleCount;
      this.sampleCount = sampleCount;
    }
    this.maxBpm = Number.isFinite(snapshot.maxBpm) ? snapshot.maxBpm : null;
    this.currentBpm = Number.isFinite(snapshot.bpm) ? snapshot.bpm : null;
    return this.snapshot();
  }

  update({ bpm } = {}) {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 260) return this.snapshot();
    this.currentBpm = bpm;
    this.totalBpm += bpm;
    this.sampleCount += 1;
    this.maxBpm = this.maxBpm === null ? bpm : Math.max(this.maxBpm, bpm);
    return this.snapshot();
  }

  pause() {
    this.currentBpm = null;
    return this.snapshot();
  }

  snapshot() {
    return {
      bpm: this.currentBpm,
      averageBpm: this.sampleCount ? this.totalBpm / this.sampleCount : null,
      maxBpm: this.maxBpm,
      sampleCount: this.sampleCount
    };
  }
}

export class HeartRateMonitorConnection {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onUpdate = () => {}, onStatus = () => {} } = {}) {
    this.bluetooth = bluetooth;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.device = null;
    this.server = null;
    this.boundDisconnect = () => this.handleDisconnect();
  }

  get supported() { return Boolean(this.bluetooth?.requestDevice); }
  get connected() { return Boolean(this.device?.gatt?.connected); }
  get canReconnect() { return Boolean(this.device); }

  async connect() {
    if (!this.supported) throw new Error("Bluetooth heart-rate connections require Chrome or Edge on a Bluetooth-capable device.");
    this.onStatus({ state: "connecting", message: "Start heart-rate broadcast or wake your strap, then select it." });
    const device = await this.bluetooth.requestDevice({ filters: [{ services: [HEART_RATE_SERVICE] }] });
    return this.connectToDevice(device, { forgetOnFailure: true });
  }

  async reconnect() {
    if (!this.supported) throw new Error("Bluetooth heart-rate connections require Chrome or Edge on a Bluetooth-capable device.");
    if (!this.device) return this.connect();
    const deviceName = this.device.name || "Heart-rate monitor";
    this.onStatus({ state: "reconnecting", message: `Reconnecting ${deviceName}.`, deviceName });
    return this.connectToDevice(this.device);
  }

  async connectToDevice(device, { forgetOnFailure = false } = {}) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    }
    this.device = device;
    device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    device.addEventListener("gattserverdisconnected", this.boundDisconnect);

    try {
      this.server = await device.gatt.connect();
      const service = await this.server.getPrimaryService(HEART_RATE_SERVICE);
      const characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT);
      characteristic.addEventListener("characteristicvaluechanged", event => this.handleMeasurement(event.target.value));
      await characteristic.startNotifications();
      const deviceName = device.name || "Heart-rate monitor";
      this.onStatus({ state: "connected", message: `${deviceName} connected`, deviceName });
      return { deviceName };
    } catch (error) {
      if (device.gatt?.connected) device.gatt.disconnect();
      this.server = null;
      if (forgetOnFailure) {
        device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
        if (this.device === device) this.device = null;
      }
      throw error;
    }
  }

  handleMeasurement(value) {
    const measurement = parseHeartRateMeasurement(value);
    this.onUpdate({ ...measurement, timestampMs: performance.now() });
  }

  handleDisconnect() {
    this.server = null;
    this.onStatus({ state: "disconnected", message: "Heart-rate monitor disconnected. Restart broadcast, then reconnect." });
  }

  disconnect() {
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.boundDisconnect);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
    this.server = null;
  }
}
