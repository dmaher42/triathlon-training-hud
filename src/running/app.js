import { HipMotionCadenceDetector } from "./motion-cadence.js";
import { RunRhythmCoach } from "./rhythm-engine.js";
import { RunSignalFusion } from "./signal-fusion.js";
import { BrowserVoiceController, VOICE_INTENTS, parseVoiceCommand } from "./voice-commands.js";
import { createRunControlAck, normaliseRunControlMessage } from "./control-protocol.js";

const doc = document;
const els = Object.fromEntries([
  "status-card", "status-value", "status-message", "status-glyph",
  "baseline-progress", "baseline-mini-progress",
  "cadence-value", "cadence-target", "cadence-delta", "baseline-value", "baseline-state",
  "baseline-summary", "stable-value", "stability-summary", "summary-state", "session-time", "walk-value", "stop-value",
  "phone-connection", "garmin-connection", "screen-connection", "install-app", "start-session", "stop-session", "run-controls",
  "planned-walk", "resume-run", "speak-status", "silence-coach", "demo-session", "voice-status",
  "voice-dock", "voice-help", "voice-mode", "voice-subtitle", "voice-toggle", "voice-prompts-toggle",
  "pocket-lock", "pocket-lock-screen", "pocket-lock-status", "pocket-lock-time", "pocket-lock-cadence",
  "pocket-unlock", "pocket-unlock-progress"
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
let voiceController = null;
let voiceResumeTimer = null;
let pendingFinishUntil = -Infinity;
const voicePromptsStorageKey = "run-durability-voice-prompts-v1";
let voicePromptsEnabled = localStorage.getItem(voicePromptsStorageKey) !== "off";
let pocketLocked = false;
let pocketUnlockTimer = null;
let installPrompt = null;
const demoEnabled = new URLSearchParams(window.location.search).has("demo");

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
  if (voiceController?.state === "unsupported") return ["VOICE UNAVAILABLE", "This browser does not support speech recognition"];
  if (voiceController?.state === "denied") return ["MICROPHONE BLOCKED", "Allow microphone access in Chrome site settings"];
  if (voiceController?.state === "no-microphone") return ["MICROPHONE MISSING", "Chrome could not access a microphone"];
  if (voiceController?.enabled) {
    if (voiceController.listening) return ["LISTENING…", "Say “Coach status” or “Voice help”"];
    return ["VOICE CONTROL ON", "Listening will resume after the current reply"];
  }
  if (snapshot.status === "REVIEW") return ["RUN REVIEW READY", "Tap Hear Status for your final summary"];
  if (snapshot.status === "SENSOR ERROR") return ["SENSOR NEEDS ATTENTION", "Resolve the sensor message before starting"];
  if (active && fieldSession && !preflightConfirmed) return ["PREFLIGHT IN PROGRESS", "Waiting for phone motion and screen-awake checks"];
  return ["VOICE CONTROL OFF", "Tap the microphone, then allow microphone access"];
}

function setVoiceIdle() {
  const [mode, subtitle] = voiceIdleState();
  els["voice-dock"].dataset.speaking = "false";
  els["voice-dock"].dataset.listening = String(Boolean(voiceController?.listening));
  els["voice-dock"].dataset.voiceError = String(["unsupported", "denied", "no-microphone"].includes(voiceController?.state));
  els["voice-toggle"].setAttribute("aria-pressed", String(Boolean(voiceController?.enabled)));
  els["voice-mode"].textContent = mode;
  els["voice-subtitle"].textContent = subtitle;
}

function handleVoiceState({ state, detail }) {
  els["voice-dock"].dataset.listening = String(state === "listening");
  els["voice-dock"].dataset.voiceError = String(["unsupported", "denied", "no-microphone"].includes(state));
  els["voice-toggle"].setAttribute("aria-pressed", String(Boolean(voiceController?.enabled)));
  if (state === "listening") {
    els["voice-mode"].textContent = "LISTENING…";
    els["voice-subtitle"].textContent = "Say “Coach status” or “Voice help”";
  } else if (["starting", "reconnecting"].includes(state)) {
    els["voice-mode"].textContent = state === "starting" ? "STARTING MICROPHONE" : "RECONNECTING VOICE";
    els["voice-subtitle"].textContent = detail === "network" ? "Chrome voice service is reconnecting" : "Listening will resume automatically";
  } else if (state === "speaking") {
    els["voice-dock"].dataset.speaking = "true";
    els["voice-mode"].textContent = "COACH SPEAKING";
    els["voice-subtitle"].textContent = "Listening is paused to avoid hearing its own reply";
  } else {
    setVoiceIdle();
  }
}

function speak(message, { force = false } = {}) {
  els["voice-status"].textContent = message;
  if (!message) return;
  if (!voicePromptsEnabled && !force) return;
  if (!("speechSynthesis" in window)) {
    els["voice-mode"].textContent = "ON-SCREEN COACH ONLY";
    els["voice-subtitle"].textContent = "Speech replies are unavailable in this browser";
    return;
  }

  const token = ++voiceSpeechToken;
  voiceController?.pauseForSpeech();
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
  let completed = false;
  const finishSpeaking = () => {
    if (completed || token !== voiceSpeechToken) return;
    completed = true;
    if (voiceResumeTimer) clearTimeout(voiceResumeTimer);
    voiceResumeTimer = null;
    voiceController?.resumeAfterSpeech();
    setVoiceIdle();
  };
  utterance.onend = finishSpeaking;
  utterance.onerror = finishSpeaking;
  voiceResumeTimer = setTimeout(finishSpeaking, Math.min(12_000, Math.max(2_500, message.length * 55)));
  window.speechSynthesis.speak(utterance);
}

function reply(message) {
  speak(message, { force: true });
}

function renderVoicePromptsToggle() {
  els["voice-prompts-toggle"].setAttribute("aria-pressed", String(voicePromptsEnabled));
  els["voice-prompts-toggle"].textContent = `PROMPTS: ${voicePromptsEnabled ? "ON" : "OFF"}`;
  els["silence-coach"].querySelector("strong").textContent = voicePromptsEnabled ? "VOICE PROMPTS OFF" : "VOICE PROMPTS ON";
  els["silence-coach"].querySelector("span").textContent = voicePromptsEnabled ? "Keep measuring silently" : "Restore automatic coaching";
}

function setVoicePrompts(enabled) {
  voicePromptsEnabled = Boolean(enabled);
  localStorage.setItem(voicePromptsStorageKey, voicePromptsEnabled ? "on" : "off");
  renderVoicePromptsToggle();
  reply(voicePromptsEnabled ? "Automatic voice prompts on." : "Automatic voice prompts off. I will keep measuring silently.");
}

function toggleVoicePrompts() {
  setVoicePrompts(!voicePromptsEnabled);
}

async function handleVoiceTranscript(alternatives) {
  const awaitingFinishConfirmation = performance.now() <= pendingFinishUntil;
  if (!awaitingFinishConfirmation) pendingFinishUntil = -Infinity;
  const parsed = alternatives.map(transcript => parseVoiceCommand(transcript, { awaitingFinishConfirmation }));
  const command = parsed.find(result => result.intent !== VOICE_INTENTS.UNKNOWN) || parsed[0];
  els["voice-subtitle"].textContent = `Heard: “${command?.transcript || alternatives[0]}”`;

  await executeRunIntent(command?.intent);
}

async function executeRunIntent(intent) {
  switch (intent) {
    case VOICE_INTENTS.START:
      if (active) reply("The run coach is already active.");
      else await startSession();
      break;
    case VOICE_INTENTS.STATUS:
      reply(statusSentence());
      break;
    case VOICE_INTENTS.PLANNED_WALK:
      if (!active) reply("Start the run coach before marking a planned walk.");
      else handleSnapshot(coach.markPlannedBreak(performance.now()));
      break;
    case VOICE_INTENTS.RESUME:
      if (!active) reply("The run coach is not active.");
      else if (!snapshot.plannedBreakActive) reply("There is no planned walk to end.");
      else handleSnapshot(coach.resumePlannedBreak(performance.now()));
      break;
    case VOICE_INTENTS.QUIET:
      setVoicePrompts(false);
      break;
    case VOICE_INTENTS.PROMPTS_ON:
      setVoicePrompts(true);
      break;
    case VOICE_INTENTS.FINISH_REQUEST:
      if (!active) reply("There is no active run to finish.");
      else {
        pendingFinishUntil = performance.now() + 8_000;
        reply("To finish the run, say confirm finish. Say keep running to cancel.");
      }
      break;
    case VOICE_INTENTS.FINISH_CONFIRM:
      pendingFinishUntil = -Infinity;
      if (active) finishSession();
      break;
    case VOICE_INTENTS.FINISH_CANCEL:
      pendingFinishUntil = -Infinity;
      reply("Finish cancelled. Keep running.");
      break;
    case VOICE_INTENTS.HELP:
      reply("You can say start run, coach status, planned walk, resume running, prompts off, prompts on, finish run, or stop listening.");
      break;
    case VOICE_INTENTS.VOICE_OFF:
      voiceController?.disable();
      reply("Voice controls off. Automatic coaching replies remain available.");
      break;
    default:
      els["voice-mode"].textContent = "COMMAND NOT RECOGNISED";
      els["voice-subtitle"].textContent = "Say “Voice help” to hear the available commands";
      break;
  }
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
  els["status-glyph"].textContent = glyphFor(snapshot.status);

  const progress = snapshot.baselineProgress || 0;
  const cadence = Number.isFinite(snapshot.cadenceSpm) ? Math.round(snapshot.cadenceSpm) : null;
  const baseline = Number.isFinite(snapshot.baselineCadenceSpm) ? snapshot.baselineCadenceSpm : null;
  els["baseline-progress"].style.width = `${progress}%`;
  els["baseline-mini-progress"].style.width = `${progress}%`;

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
  els["pocket-lock-status"].textContent = snapshot.status;
  els["pocket-lock-time"].textContent = formatMinutes(elapsedMs);
  els["pocket-lock-cadence"].textContent = cadence ?? "—";

  els["start-session"].hidden = active;
  els["stop-session"].hidden = !active;
  els["run-controls"].hidden = !active;
  els["install-app"].hidden = active || isInstalledApp();
  els["demo-session"].hidden = active || !demoEnabled;
  doc.body.dataset.session = active ? "active" : snapshot.status === "REVIEW" ? "review" : "ready";
  els["voice-help"].textContent = active
    ? fieldSession && !preflightConfirmed
      ? "Move the phone gently while the app confirms motion and screen protection."
      : voiceController?.enabled
        ? "Hands-free controls are active. Say “Voice help” to hear the commands."
        : "Tap the microphone to enable hands-free commands."
    : voiceController?.supported
      ? "Tap once to enable hands-free commands, then leave the screen open."
      : "Voice commands are unavailable in this browser. Spoken replies still work.";
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
  setPocketLock(false);
  pendingFinishUntil = -Infinity;
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

export async function ingestGarminControl(payload) {
  let message;
  try {
    message = normaliseRunControlMessage(payload);
  } catch (error) {
    return {
      type: "run-control-ack",
      version: 1,
      requestId: String(payload?.requestId || "").slice(0, 64),
      command: String(payload?.command || "unknown"),
      accepted: false,
      detail: error.message
    };
  }
  await executeRunIntent(message.command);
  return createRunControlAck(message, { accepted: true, detail: "Command received by phone coach" });
}

function toggleVoiceControls() {
  if (voiceController.enabled) {
    voiceController.disable();
    reply("Voice controls off. Automatic coaching replies remain available.");
    return;
  }
  voiceController.enable();
}

function resumeRunning() {
  if (!active) {
    reply("The run coach is not active.");
    return;
  }
  if (!snapshot.plannedBreakActive) {
    reply("There is no planned walk to end.");
    return;
  }
  handleSnapshot(coach.resumePlannedBreak(performance.now()));
}

function isInstalledApp() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

async function installRunningApp() {
  if (installPrompt) {
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    els["install-app"].hidden = true;
    return;
  }
  window.alert("In Chrome, tap the three-dot menu, then tap Add to Home screen or Install app.");
}

async function setPocketLock(locked) {
  pocketLocked = Boolean(locked && active);
  els["pocket-lock-screen"].hidden = !pocketLocked;
  doc.querySelector(".run-shell").inert = pocketLocked;
  doc.body.classList.toggle("pocket-locked", pocketLocked);
  cancelPocketUnlock();
  if (pocketLocked) {
    await requestWakeLock();
    try { await doc.documentElement.requestFullscreen?.({ navigationUI: "hide" }); } catch (_) {}
    reply("Pocket lock on. Press and hold the unlock button for two seconds to unlock.");
  } else if (doc.fullscreenElement) {
    try { await doc.exitFullscreen(); } catch (_) {}
  }
}

function cancelPocketUnlock() {
  if (pocketUnlockTimer) clearTimeout(pocketUnlockTimer);
  pocketUnlockTimer = null;
  els["pocket-unlock"].classList.remove("is-holding");
  els["pocket-unlock"].style.setProperty("--unlock-progress", "0");
  els["pocket-unlock-progress"].textContent = "Hold for 2 seconds";
}

function beginPocketUnlock(event) {
  if (!pocketLocked || pocketUnlockTimer) return;
  event.preventDefault();
  els["pocket-unlock"].setPointerCapture?.(event.pointerId);
  els["pocket-unlock"].classList.add("is-holding");
  requestAnimationFrame(() => els["pocket-unlock"].style.setProperty("--unlock-progress", "1"));
  els["pocket-unlock-progress"].textContent = "Keep holding…";
  pocketUnlockTimer = setTimeout(() => setPocketLock(false), 1_800);
}

window.runCoachGarminSample = ingestGarminTelemetry;
window.runCoachGarminControl = ingestGarminControl;
window.runCoachVoiceCommand = transcript => handleVoiceTranscript([String(transcript || "")]);
voiceController = BrowserVoiceController.fromWindow(window, {
  onTranscript: handleVoiceTranscript,
  onState: handleVoiceState
});
els["start-session"].addEventListener("click", startSession);
els["stop-session"].addEventListener("click", finishSession);
els["demo-session"].addEventListener("click", startDemo);
els["planned-walk"].addEventListener("click", () => handleSnapshot(coach.markPlannedBreak(performance.now())));
els["resume-run"].addEventListener("click", resumeRunning);
els["speak-status"].addEventListener("click", () => reply(statusSentence()));
els["silence-coach"].addEventListener("click", toggleVoicePrompts);
els["voice-toggle"].addEventListener("click", toggleVoiceControls);
els["voice-prompts-toggle"].addEventListener("click", toggleVoicePrompts);
els["install-app"].addEventListener("click", installRunningApp);
els["pocket-lock"].addEventListener("click", () => setPocketLock(true));
els["pocket-unlock"].addEventListener("pointerdown", beginPocketUnlock);
for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) {
  els["pocket-unlock"].addEventListener(eventName, cancelPocketUnlock);
}
document.addEventListener("visibilitychange", () => {
  voiceController.setPageVisible(document.visibilityState === "visible");
  if (active && fieldSession && document.visibilityState === "visible") requestWakeLock();
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  els["install-app"].hidden = false;
  els["install-app"].textContent = "INSTALL RUNNING APP";
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  els["install-app"].hidden = true;
});

els["install-app"].hidden = isInstalledApp();
renderVoicePromptsToggle();
render(true);
