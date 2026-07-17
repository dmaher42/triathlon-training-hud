import { HipMotionCadenceDetector } from "./motion-cadence.js";
import { RunRhythmCoach } from "./rhythm-engine.js";
import { RunSignalFusion } from "./signal-fusion.js";

const doc = document;
const els = Object.fromEntries([
  "status-card", "status-value", "status-message", "status-detail", "status-glyph",
  "baseline-progress", "baseline-copy", "baseline-check", "baseline-mini-progress",
  "cadence-value", "cadence-target", "cadence-delta", "baseline-value", "baseline-state",
  "baseline-summary", "stable-value", "stability-summary", "summary-state", "session-time", "walk-value", "stop-value",
  "phone-connection", "garmin-connection", "screen-connection", "start-session", "stop-session", "run-controls",
  "planned-walk", "speak-status", "silence-coach", "demo-session", "voice-status",
  "voice-dock", "voice-help", "voice-mode", "voice-subtitle"
].map(id => [id, doc.getElementById(id)]));

let detector = new HipMotionCadenceDetector();
let fusion = new RunSignalFusion();
let coach = new RunRhythmCoach();
let snapshot = coach.snapshot(0);
let active = false;
let wakeLock = null;
let demoTimer = null;
let demoStartedAt = null;
let lastRenderAt = -Infinity;
let sessionStartedAtMs = null;
let lastSessionElapsedMs = 0;
let voiceSpeechToken = 0;
let fieldSession = false;
let motionSignalConfirmed = false;
let preflightConfirmed = false;
let preflightAnnounced = false;
let motionSignalTimeout = null;

function toneFor(status) {
  if (["FADING", "WALKING"].includes(status)) return "attention";
  if (["STOPPED", "PLANNED STOP", "SENSOR ERROR"].includes(status)) return "stopped";
  return "ready";
}

function formatMinutes(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function detailFor(status) {
  const details = {
    READY: "Secure the phone in the same hip pocket for every run.",
    PREFLIGHT: "Confirming motion data and keeping the screen awake.",
    CALIBRATING: "Run naturally while your opening rhythm is learned.",
    STEADY: "Your cadence is inside its personal rhythm band.",
    FADING: "A sustained cadence drop has been detected.",
    RESET: "Build back into your natural rhythm without rushing.",
    WALKING: "This walk was not marked as part of your plan.",
    "PLANNED WALK": "This recovery is excluded from continuity coaching.",
    "PLANNED STOP": "This stop is excluded from continuity coaching.",
    STOPPED: "The coach will continue automatically when you move.",
    REVIEW: "Your rhythm and continuity summary is ready.",
    "SENSOR ERROR": "Check browser motion permission and try again."
  };
  return details[status] || "Rhythm coaching is active.";
}

function glyphFor(status) {
  if (["FADING", "WALKING"].includes(status)) return "↘";
  if (["STOPPED", "PLANNED STOP", "SENSOR ERROR"].includes(status)) return "■";
  if (["PREFLIGHT", "CALIBRATING", "RESET"].includes(status)) return "••";
  if (status === "PLANNED WALK") return "Ⅱ";
  return "✓";
}

function statusSentence() {
  const cadence = Number.isFinite(snapshot.cadenceSpm) ? `${Math.round(snapshot.cadenceSpm)} steps per minute` : "cadence is still settling";
  const baseline = Number.isFinite(snapshot.baselineCadenceSpm) ? `Your baseline is ${snapshot.baselineCadenceSpm}` : `Baseline learning is ${snapshot.baselineProgress} percent complete`;
  return `${snapshot.message} Current ${cadence}. ${baseline}. ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}.`;
}

function voiceIdleState() {
  if (snapshot.status === "REVIEW") return ["RUN REVIEW READY", "Tap the microphone to hear your final summary"];
  if (snapshot.status === "SENSOR ERROR") return ["SENSOR NEEDS ATTENTION", "Resolve the sensor message before starting"];
  if (active && fieldSession && !preflightConfirmed) return ["PREFLIGHT IN PROGRESS", "Waiting for phone motion and screen-awake checks"];
  if (active) return ["COACHING ACTIVE", "Tap the microphone to hear your current status"];
  return ["VOICE COACH READY", "Tap the microphone to hear your current status"];
}

function setVoiceIdle() {
  const [mode, subtitle] = voiceIdleState();
  els["voice-dock"].dataset.speaking = "false";
  els["voice-mode"].textContent = mode;
  els["voice-subtitle"].textContent = subtitle;
}

function speak(message) {
  els["voice-status"].textContent = message;
  if (!message) return;
  if (!("speechSynthesis" in window)) {
    els["voice-mode"].textContent = "ON-SCREEN COACH ONLY";
    els["voice-subtitle"].textContent = "Speech replies are unavailable in this browser";
    return;
  }

  const token = ++voiceSpeechToken;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 1.02;
  utterance.pitch = 0.96;
  utterance.onstart = () => {
    if (token !== voiceSpeechToken) return;
    els["voice-dock"].dataset.speaking = "true";
    els["voice-mode"].textContent = "COACH SPEAKING";
    els["voice-subtitle"].textContent = "Spoken reply in progress";
  };
  const finishSpeaking = () => {
    if (token === voiceSpeechToken) setVoiceIdle();
  };
  utterance.onend = finishSpeaking;
  utterance.onerror = finishSpeaking;
  window.speechSynthesis.speak(utterance);
}

function handleSnapshot(nextSnapshot) {
  snapshot = nextSnapshot;
  for (const event of snapshot.events || []) {
    if (event.speak) speak(event.message);
  }
  render();
}

function render(force = false) {
  const now = performance.now();
  if (!force && now - lastRenderAt < 180) return;
  lastRenderAt = now;

  els["status-card"].dataset.tone = toneFor(snapshot.status);
  els["status-value"].textContent = snapshot.status;
  els["status-value"].classList.toggle("is-long", snapshot.status.length > 8);
  els["status-message"].textContent = snapshot.message;
  els["status-detail"].textContent = detailFor(snapshot.status);
  els["status-glyph"].textContent = glyphFor(snapshot.status);

  const progress = snapshot.baselineProgress || 0;
  const cadence = Number.isFinite(snapshot.cadenceSpm) ? Math.round(snapshot.cadenceSpm) : null;
  const baseline = Number.isFinite(snapshot.baselineCadenceSpm) ? snapshot.baselineCadenceSpm : null;
  els["baseline-progress"].style.width = `${progress}%`;
  els["baseline-mini-progress"].style.width = `${progress}%`;
  els["baseline-copy"].textContent = baseline
    ? `Personal baseline learned · ${baseline} steps/min`
    : snapshot.active ? `Learning personal baseline · ${progress}%` : "Personal baseline not started";
  els["baseline-check"].textContent = baseline ? "✓" : "○";

  els["cadence-value"].textContent = cadence ?? "—";
  els["cadence-target"].textContent = baseline ?? "—";
  els["baseline-value"].textContent = baseline ?? "—";
  els["baseline-state"].textContent = baseline ? "CONFIRMED" : snapshot.active ? `${progress}%` : "NOT STARTED";
  els["baseline-summary"].textContent = baseline
    ? "Confirmed from your opening natural rhythm"
    : snapshot.active ? "Learning from steady running samples" : "Starts with two minutes of natural running";

  if (cadence !== null && baseline !== null) {
    const delta = (cadence - baseline) / baseline * 100;
    els["cadence-delta"].textContent = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    els["cadence-delta"].dataset.delta = delta < -3 ? "low" : "good";
  } else {
    els["cadence-delta"].textContent = snapshot.active ? "SETTLING" : "WAITING";
    els["cadence-delta"].dataset.delta = "";
  }

  els["stable-value"].textContent = `${snapshot.stablePercent || 0}%`;
  els["stability-summary"].textContent = baseline
    ? snapshot.driftActive ? "Below your personal rhythm band" : `${snapshot.stablePercent || 0}% of running held steady`
    : snapshot.active ? "Available after the baseline is learned" : "Waiting for your opening rhythm";
  const elapsedMs = active && sessionStartedAtMs !== null
    ? Math.max(0, snapshot.timestampMs - sessionStartedAtMs)
    : lastSessionElapsedMs;
  els["session-time"].textContent = formatMinutes(elapsedMs);
  els["walk-value"].textContent = snapshot.unplannedWalks || 0;
  els["stop-value"].textContent = snapshot.stopCount || 0;
  els["summary-state"].textContent = snapshot.status === "REVIEW" ? "FINAL" : active ? "LIVE" : "READY";

  els["start-session"].hidden = active;
  els["stop-session"].hidden = !active;
  els["run-controls"].hidden = !active;
  els["demo-session"].hidden = active;
  els["voice-help"].textContent = active
    ? fieldSession && !preflightConfirmed
      ? "Move the phone gently while the app confirms motion and screen protection."
      : "Automatic spoken cues are active. Tap below for a full status reply."
    : "Spoken replies are ready. Android voice commands are the next platform step.";
  if (els["voice-dock"].dataset.speaking !== "true") setVoiceIdle();
}

function setConnection(id, label, state = "ready") {
  const element = els[id];
  element.classList.toggle("muted", state === "muted");
  element.classList.toggle("warning", state === "warning");
  element.innerHTML = `<i></i> ${label}`;
}

function clearMotionTimeout() {
  if (motionSignalTimeout) clearTimeout(motionSignalTimeout);
  motionSignalTimeout = null;
}

function maybeConfirmPreflight() {
  if (!active || !fieldSession || !motionSignalConfirmed || !wakeLock || wakeLock.released) return;
  setConnection("phone-connection", "PHONE LIVE");
  setConnection("screen-connection", "SCREEN AWAKE");
  if (preflightConfirmed) return;
  preflightConfirmed = true;
  render(true);
  if (!preflightAnnounced) {
    preflightAnnounced = true;
    speak("Preflight passed. Run naturally while I learn your rhythm.");
  }
}

async function requestWakeLock() {
  if (!navigator.wakeLock?.request) {
    setConnection("screen-connection", "WAKE LOCK MISSING", "warning");
    return false;
  }
  if (wakeLock && !wakeLock.released) {
    setConnection("screen-connection", "SCREEN AWAKE");
    maybeConfirmPreflight();
    return true;
  }
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    wakeLock = sentinel;
    sentinel.addEventListener?.("release", () => {
      if (wakeLock === sentinel) wakeLock = null;
      if (active && fieldSession) {
        preflightConfirmed = false;
        setConnection("screen-connection", "SCREEN NOT HELD", "warning");
      }
    });
    setConnection("screen-connection", "SCREEN AWAKE");
    maybeConfirmPreflight();
    return true;
  } catch (_) {
    setConnection("screen-connection", "WAKE LOCK FAILED", "warning");
    return false;
  }
}

async function releaseWakeLock({ resetLabel = true } = {}) {
  const sentinel = wakeLock;
  wakeLock = null;
  try { await sentinel?.release(); } catch (_) {}
  if (resetLabel) setConnection("screen-connection", "SCREEN CHECK", "muted");
}

async function requestMotionPermission() {
  if (!("DeviceMotionEvent" in window)) throw new Error("This browser does not expose the phone motion sensor.");
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    const permission = await DeviceMotionEvent.requestPermission();
    if (permission !== "granted") throw new Error("Motion access was not granted.");
  }
}

function processSignal(signal) {
  handleSnapshot(coach.update({
    timestampMs: signal.timestampMs,
    cadenceSpm: signal.cadenceSpm,
    movementState: signal.movementState
  }));
  els["garmin-connection"].classList.toggle("muted", !signal.garminConnected);
  els["garmin-connection"].innerHTML = `<i></i> ${signal.garminConnected ? "GARMIN LIVE" : "GARMIN OFFLINE"}`;
}

function hasMotionVector(event) {
  const vector = event.accelerationIncludingGravity || event.acceleration;
  return Boolean(vector) && [vector.x, vector.y, vector.z].some(value => Number.isFinite(Number(value)));
}

function onDeviceMotion(event) {
  if (!active || !hasMotionVector(event)) return;
  let firstMotionSignal = false;
  if (fieldSession && !motionSignalConfirmed) {
    motionSignalConfirmed = true;
    firstMotionSignal = true;
    clearMotionTimeout();
    setConnection("phone-connection", "MOTION CONFIRMED");
  }
  const timestampMs = performance.now();
  const phone = detector.update({
    timestampMs,
    acceleration: event.acceleration,
    accelerationIncludingGravity: event.accelerationIncludingGravity
  });
  processSignal(fusion.updatePhone({ timestampMs, ...phone }));
  if (firstMotionSignal) maybeConfirmPreflight();
}

function failPreflight(message, source = "motion") {
  clearMotionTimeout();
  active = false;
  fieldSession = false;
  preflightConfirmed = false;
  sessionStartedAtMs = null;
  window.removeEventListener("devicemotion", onDeviceMotion);
  releaseWakeLock({ resetLabel: false });
  if (source === "wake") {
    setConnection("phone-connection", "PHONE CHECK", "muted");
    setConnection("screen-connection", "WAKE LOCK FAILED", "warning");
  } else {
    setConnection("phone-connection", "NO MOTION SIGNAL", "warning");
    setConnection("screen-connection", "SCREEN CHECK", "muted");
  }
  snapshot = { ...snapshot, status: "SENSOR ERROR", message, events: [] };
  speak(message);
  render(true);
}

async function startSession() {
  try {
    await requestMotionPermission();
    detector = new HipMotionCadenceDetector();
    fusion = new RunSignalFusion();
    coach = new RunRhythmCoach();
    active = true;
    fieldSession = true;
    motionSignalConfirmed = false;
    preflightConfirmed = false;
    preflightAnnounced = false;
    sessionStartedAtMs = performance.now();
    lastSessionElapsedMs = 0;
    setConnection("phone-connection", "WAITING FOR MOTION", "warning");
    setConnection("screen-connection", "CHECKING SCREEN", "warning");
    window.addEventListener("devicemotion", onDeviceMotion);
    snapshot = {
      ...coach.start(sessionStartedAtMs),
      status: "PREFLIGHT",
      message: "Checking phone motion and screen-awake protection."
    };
    render(true);
    const screenReady = await requestWakeLock();
    if (!screenReady) {
      failPreflight("Screen-awake protection failed. Turn off Battery Saver and try again.", "wake");
      return;
    }
    if (!motionSignalConfirmed) {
      motionSignalTimeout = setTimeout(() => {
        if (active && fieldSession && !motionSignalConfirmed) {
          failPreflight("No phone motion signal arrived. Check Chrome motion access and try again.");
        }
      }, 6_000);
    }
    maybeConfirmPreflight();
  } catch (error) {
    failPreflight(error?.message || "The phone motion sensor could not start.");
  }
}

function finishSession() {
  if (!active) return;
  clearMotionTimeout();
  lastSessionElapsedMs = sessionStartedAtMs === null ? 0 : Math.max(0, snapshot.timestampMs - sessionStartedAtMs);
  active = false;
  fieldSession = false;
  preflightConfirmed = false;
  sessionStartedAtMs = null;
  window.removeEventListener("devicemotion", onDeviceMotion);
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = null;
  releaseWakeLock();
  const summary = `Field test complete. ${snapshot.stablePercent} percent of running time was inside your rhythm band. ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}. Longest steady block ${formatMinutes(snapshot.longestStableBlockMs)}.`;
  snapshot = { ...snapshot, status: "REVIEW", message: summary, events: [] };
  setConnection("phone-connection", "PHONE READY");
  speak(summary);
  render(true);
}

function startDemo() {
  clearMotionTimeout();
  detector = new HipMotionCadenceDetector();
  fusion = new RunSignalFusion();
  coach = new RunRhythmCoach({
    baselineDurationMs: 4_000,
    baselineSampleEveryMs: 500,
    baselineMinSamples: 6,
    driftHoldMs: 3_000,
    recoveryHoldMs: 1_500,
    walkHoldMs: 1_500,
    cueCooldownMs: 0
  });
  active = true;
  fieldSession = false;
  motionSignalConfirmed = false;
  preflightConfirmed = false;
  demoStartedAt = performance.now();
  sessionStartedAtMs = demoStartedAt;
  lastSessionElapsedMs = 0;
  handleSnapshot(coach.start(demoStartedAt));
  setConnection("phone-connection", "DEMO SIGNAL LIVE");
  setConnection("screen-connection", "DEMO MODE", "muted");
  speak("Short demonstration started.");
  demoTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - demoStartedAt;
    let cadenceSpm = 170;
    let movementState = "running";
    if (elapsed >= 7_000 && elapsed < 13_000) cadenceSpm = 154;
    if (elapsed >= 13_000 && elapsed < 16_000) { cadenceSpm = 100; movementState = "walking"; }
    processSignal(fusion.updatePhone({ timestampMs: now, cadenceSpm, movementState, motionIntensity: 1.2 }));
    if (elapsed >= 20_000) finishSession();
  }, 250);
}

export function ingestGarminTelemetry(payload) {
  const signal = fusion.updateGarmin(payload);
  if (active) processSignal(signal);
  return signal;
}

window.runCoachGarminSample = ingestGarminTelemetry;
els["start-session"].addEventListener("click", startSession);
els["stop-session"].addEventListener("click", finishSession);
els["demo-session"].addEventListener("click", startDemo);
els["planned-walk"].addEventListener("click", () => handleSnapshot(coach.markPlannedBreak(performance.now())));
els["speak-status"].addEventListener("click", () => speak(statusSentence()));
els["silence-coach"].addEventListener("click", () => handleSnapshot(coach.silence(performance.now())));
document.addEventListener("visibilitychange", () => {
  if (active && fieldSession && document.visibilityState === "visible") requestWakeLock();
});

render(true);
