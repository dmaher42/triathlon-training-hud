import { HipMotionCadenceDetector } from "./motion-cadence.js";
import { RunRhythmCoach } from "./rhythm-engine.js";
import { RunSignalFusion } from "./signal-fusion.js";
import { BrowserVoiceController, VOICE_INTENTS, parseVoiceCommand } from "./voice-commands.js";
import { createRunControlAck, normaliseRunControlMessage } from "./control-protocol.js";
import { HipFormAnalyzer } from "./hip-form-analyzer.js";
import {
  closeInterruption, createInterruption, interruptionSummary,
  makePersistedSession, parsePersistedSession
} from "./session-resilience.js";

const doc = document;
const els = Object.fromEntries([
  "status-card", "status-value", "status-message", "status-glyph",
  "baseline-progress", "baseline-mini-progress",
  "cadence-value", "cadence-target", "cadence-delta", "baseline-value", "baseline-state",
  "baseline-summary", "stable-value", "stability-summary", "summary-state", "session-time", "walk-value", "stop-value", "interruption-value",
  "phone-connection", "garmin-connection", "screen-connection", "install-app", "start-session", "stop-session", "run-controls",
  "planned-walk", "resume-run", "speak-status", "silence-coach", "start-vibration", "demo-session", "voice-status",
  "voice-dock", "voice-help", "voice-mode", "voice-subtitle", "voice-toggle", "voice-prompts-toggle",
  "pocket-lock", "pocket-lock-screen", "pocket-lock-status", "pocket-lock-time", "pocket-lock-cadence",
  "pocket-unlock", "pocket-unlock-progress", "pocket-lock-health", "resume-session",
  "preflight-panel", "preflight-motion", "preflight-screen", "preflight-pocket", "preflight-battery", "preflight-save",
  "form-lab", "form-vertical", "form-horizontal", "form-rotation", "form-impact",
  "form-status", "form-confidence", "form-progress", "pocket-side-left", "pocket-side-right",
  "form-segment-review", "form-middle", "form-late"
].map(id => [id, doc.getElementById(id)]));

let detector = new HipMotionCadenceDetector();
let fusion = new RunSignalFusion();
let coach = new RunRhythmCoach();
let formAnalyzer = new HipFormAnalyzer();
let formSnapshot = formAnalyzer.snapshot(0);
let snapshot = coach.snapshot(0);
let active = false;
let wakeLock = null;
let demoTimer = null;
let demoStartedAt = null;
let lastRenderAt = -Infinity;
let sessionStartedAtMs = null;
let sessionStartedAtEpochMs = null;
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
let voicePromptsEnabled = readStoredText(voicePromptsStorageKey) !== "off";
const startVibrationStorageKey = "run-durability-start-vibration-v1";
let startVibrationEnabled = readStoredText(startVibrationStorageKey) !== "off";
const activeSessionStorageKey = "run-durability-active-session-v1";
const completedFormStorageKey = "run-durability-completed-form-v1";
let pocketLocked = false;
let pocketUnlockTimer = null;
let installPrompt = null;
const demoEnabled = new URLSearchParams(window.location.search).has("demo");
let batteryStatus = { supported: false, sufficient: null, level: null, charging: null };
let batteryManager = null;
let lastMotionAtMs = null;
let interruptionActive = null;
let interruptions = [];
let resilienceTimer = null;
let lastPersistAttemptAtMs = -Infinity;
let savedSession = parsePersistedSession(readStoredText(activeSessionStorageKey));
const pocketSideStorageKey = "run-durability-pocket-side-v1";
let pocketSide = readStoredText(pocketSideStorageKey) === "left" ? "left" : "right";
let storageHealthy = null;
let completedFormReport = readStoredJson(completedFormStorageKey);
if (savedSession && completedFormReport?.version === 1 && completedFormReport.completedAtEpochMs >= savedSession.savedAtEpochMs) {
  savedSession = null;
  try { localStorage.removeItem(activeSessionStorageKey); } catch (_) {}
}

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

function setPreflightItem(id, label, state = "waiting") {
  const element = els[id];
  element.dataset.state = state;
  element.innerHTML = `<i></i>${label}`;
}

function updateBatteryDisplay() {
  if (!batteryStatus.supported) {
    setPreflightItem("preflight-battery", "BATTERY MANUAL", "unknown");
    return;
  }
  const percent = Math.round((batteryStatus.level ?? 0) * 100);
  const safe = batteryStatus.charging || batteryStatus.sufficient;
  setPreflightItem("preflight-battery", batteryStatus.charging ? `CHARGING ${percent}%` : `BATTERY ${percent}%`, safe ? "ready" : "warning");
}

async function initialiseBatteryCheck() {
  if (!navigator.getBattery) {
    updateBatteryDisplay();
    return;
  }
  try {
    batteryManager = await navigator.getBattery();
    const refresh = () => {
      batteryStatus = {
        supported: true,
        level: batteryManager.level,
        charging: batteryManager.charging,
        sufficient: batteryManager.charging || batteryManager.level >= 0.2
      };
      updateBatteryDisplay();
    };
    batteryManager.addEventListener?.("levelchange", refresh);
    batteryManager.addEventListener?.("chargingchange", refresh);
    refresh();
  } catch (_) {
    batteryStatus = { supported: false, sufficient: null, level: null, charging: null };
    updateBatteryDisplay();
  }
}

function renderStartVibration() {
  els["start-vibration"].querySelector("strong").textContent = `START VIBRATION: ${startVibrationEnabled ? "ON" : "OFF"}`;
  els["start-vibration"].querySelector("span").textContent = "Tap to change";
}

function setPocketSide(side) {
  if (active) return;
  pocketSide = side === "left" ? "left" : "right";
  writeStoredText(pocketSideStorageKey, pocketSide);
  renderPocketSide();
}

function renderPocketSide() {
  for (const side of ["left", "right"]) {
    els[`pocket-side-${side}`].setAttribute("aria-pressed", String(pocketSide === side));
    els[`pocket-side-${side}`].disabled = active;
  }
}

function formatFormChange(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function segmentReviewLabel(label, drift) {
  if (!drift || !Number.isFinite(drift.verticalPercent)) return `${label} —`;
  const rotation = Number.isFinite(drift.rotationPercent) ? ` · ROT ${formatFormChange(drift.rotationPercent)}` : "";
  return `${label} BOUNCE ${formatFormChange(drift.verticalPercent)}${rotation}`;
}

function renderFormLab() {
  const drift = formSnapshot.drift || {};
  els["form-vertical"].textContent = formatFormChange(drift.verticalPercent);
  els["form-horizontal"].textContent = formatFormChange(drift.horizontalPercent);
  els["form-rotation"].textContent = formSnapshot.totalSamples && formSnapshot.capabilities?.rotationAvailable === false
    ? "N/A"
    : formatFormChange(drift.rotationPercent);
  els["form-impact"].textContent = formatFormChange(drift.impactPercent);
  els["form-progress"].style.width = `${formSnapshot.baselineProgress || 0}%`;
  els["form-confidence"].textContent = `${formSnapshot.confidence || 0}% CONFIDENCE`;
  const isReview = !active && Boolean(formSnapshot.totalSamples);
  const reviewStatus = !formSnapshot.baselineReady
    ? `Saved ${pocketSide} hip run · insufficient data for comparison`
    : formSnapshot.segments?.late
      ? `Saved ${pocketSide} hip report · opening, middle and final retained`
      : formSnapshot.segments?.middle
        ? `Saved ${pocketSide} hip report · final section not reached`
        : `Saved ${pocketSide} hip baseline · middle section not reached`;
  els["form-segment-review"].hidden = !isReview;
  els["form-middle"].textContent = segmentReviewLabel("MIDDLE", formSnapshot.segmentDrift?.middle);
  els["form-late"].textContent = segmentReviewLabel("FINAL", formSnapshot.segmentDrift?.late);
  els["form-status"].textContent = isReview
    ? reviewStatus
    : formSnapshot.placementConsistent === false
      ? "Phone position changed — measurement confidence reduced"
      : formSnapshot.baselineReady
        ? formSnapshot.capabilities?.rotationAvailable === false
          ? "Recent movement compared · rotation unavailable"
          : "Recent five minutes compared with your opening movement"
        : active
          ? `Learning ${pocketSide} hip movement · ${formSnapshot.baselineProgress || 0}%`
          : "Starts by learning ten minutes of running";
  renderPocketSide();
}

function toggleStartVibration() {
  startVibrationEnabled = !startVibrationEnabled;
  writeStoredText(startVibrationStorageKey, startVibrationEnabled ? "on" : "off");
  renderStartVibration();
}

function readStoredText(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writeStoredText(key, value) {
  try {
    localStorage.setItem(key, value);
    setSaveHealth(true);
    return true;
  } catch (_) {
    setSaveHealth(false);
    return false;
  }
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function setSaveHealth(healthy, label = healthy ? "SAVE READY" : "SAVE FAILED") {
  storageHealthy = healthy;
  setPreflightItem("preflight-save", label, healthy ? "ready" : "warning");
  if (!healthy && pocketLocked) els["pocket-lock-health"].textContent = "RUN ACTIVE · SAVE FAILED";
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    setSaveHealth(true);
    return true;
  } catch (_) {
    setSaveHealth(false);
    return false;
  }
}

function initialiseStorageCheck() {
  const key = "run-durability-storage-check";
  try {
    localStorage.setItem(key, "ok");
    localStorage.removeItem(key);
    setSaveHealth(true);
  } catch (_) {
    setSaveHealth(false);
  }
}

function beginInterruption(reason) {
  if (!active || !fieldSession || interruptionActive) return;
  interruptionActive = createInterruption({ reason, startedAtEpochMs: Date.now() });
  interruptions.push(interruptionActive);
  persistActiveSession(true);
}

function endInterruption() {
  if (!interruptionActive) return;
  const closed = closeInterruption(interruptionActive, Date.now());
  interruptions[interruptions.length - 1] = closed;
  interruptionActive = null;
  persistActiveSession(true);
}

function persistActiveSession(force = false) {
  if (!active || !fieldSession || sessionStartedAtEpochMs === null) return;
  const now = performance.now();
  if (!force && now - lastPersistAttemptAtMs < 5_000) return;
  lastPersistAttemptAtMs = now;
  const payload = makePersistedSession({
    startedAtEpochMs: sessionStartedAtEpochMs,
    coachState: coach.exportState(),
    formState: formAnalyzer.exportState(),
    pocketSide,
    interruptions
  });
  writeStoredJson(activeSessionStorageKey, payload);
}

function clearPersistedSession() {
  try {
    localStorage.removeItem(activeSessionStorageKey);
    savedSession = null;
    return true;
  } catch (_) {
    setSaveHealth(false);
    return false;
  }
}

function startResilienceMonitor() {
  if (resilienceTimer) clearInterval(resilienceTimer);
  resilienceTimer = setInterval(() => {
    if (!active || !fieldSession) return;
    const now = performance.now();
    const motionMissing = lastMotionAtMs !== null && now - lastMotionAtMs > 5_000;
    if (document.visibilityState !== "visible") {
      beginInterruption("app-hidden");
    } else if (motionMissing) {
      beginInterruption("motion-gap");
      setConnection("phone-connection", "MOTION INTERRUPTED", "warning");
      els["pocket-lock-health"].textContent = "MOTION INTERRUPTED · KEEP SCREEN ACTIVE";
    } else if (interruptionActive) {
      endInterruption();
    }
    if (!wakeLock || wakeLock.released) requestWakeLock();
    persistActiveSession();
    render();
  }, 2_000);
}

function stopResilienceMonitor() {
  if (resilienceTimer) clearInterval(resilienceTimer);
  resilienceTimer = null;
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
  writeStoredText(voicePromptsStorageKey, voicePromptsEnabled ? "on" : "off");
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
  els["interruption-value"].textContent = interruptionSummary(interruptions).count;
  els["summary-state"].textContent = snapshot.status === "REVIEW" ? "FINAL" : active ? "LIVE" : "READY";
  els["pocket-lock-status"].textContent = snapshot.status;
  els["pocket-lock-time"].textContent = formatMinutes(elapsedMs);
  els["pocket-lock-cadence"].textContent = cadence ?? "—";

  if (!interruptionActive) {
    els["pocket-lock-health"].textContent = storageHealthy === false
      ? "RUN ACTIVE · SAVE FAILED"
      : preflightConfirmed ? "MOTION LIVE · SCREEN PROTECTED" : "POCKET CHECK IN PROGRESS";
  }
  els["start-session"].hidden = active || Boolean(savedSession);
  els["resume-session"].hidden = active || !savedSession;
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
  renderFormLab();
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
  setPreflightItem("preflight-motion", "MOTION LIVE", "ready");
  setPreflightItem("preflight-screen", "SCREEN PROTECTED", "ready");
  setPreflightItem("preflight-pocket", "POCKET LOCKED", "ready");
  setPocketLock(true, { announce: false });
  render(true);
  if (!preflightAnnounced) {
    preflightAnnounced = true;
    if (startVibrationEnabled) navigator.vibrate?.([120, 80, 180]);
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
        setPreflightItem("preflight-screen", "SCREEN RECOVERING", "warning");
        beginInterruption("wake-lock-released");
        if (document.visibilityState === "visible") setTimeout(() => requestWakeLock(), 250);
      }
    });
    setConnection("screen-connection", "SCREEN AWAKE");
    setPreflightItem("preflight-screen", "SCREEN PROTECTED", "ready");
    if (interruptionActive?.reason === "wake-lock-released") endInterruption();
    maybeConfirmPreflight();
    return true;
  } catch (_) {
    setConnection("screen-connection", "WAKE LOCK FAILED", "warning");
    setPreflightItem("preflight-screen", "SCREEN FAILED", "warning");
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
    if (interruptionActive) endInterruption();
  }
  const timestampMs = performance.now();
  lastMotionAtMs = timestampMs;
  if (interruptionActive?.reason === "motion-gap") endInterruption();
  const phone = detector.update({
    timestampMs,
    acceleration: event.acceleration,
    accelerationIncludingGravity: event.accelerationIncludingGravity
  });
  formSnapshot = formAnalyzer.update({
    timestampMs,
    accelerationIncludingGravity: event.accelerationIncludingGravity,
    rotationRate: event.rotationRate,
    movementState: phone.movementState,
    stepDetected: phone.stepDetected
  });
  processSignal(fusion.updatePhone({ timestampMs, ...phone }));
  persistActiveSession();
  if (firstMotionSignal) maybeConfirmPreflight();
}

function failPreflight(message, source = "motion") {
  clearMotionTimeout();
  active = false;
  fieldSession = false;
  preflightConfirmed = false;
  sessionStartedAtMs = null;
  sessionStartedAtEpochMs = null;
  stopResilienceMonitor();
  clearPersistedSession();
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
    formAnalyzer = new HipFormAnalyzer();
    active = true;
    fieldSession = true;
    motionSignalConfirmed = false;
    preflightConfirmed = false;
    preflightAnnounced = false;
    sessionStartedAtMs = performance.now();
    sessionStartedAtEpochMs = Date.now();
    lastSessionElapsedMs = 0;
    interruptions = [];
    interruptionActive = null;
    lastMotionAtMs = null;
    savedSession = null;
    setPreflightItem("preflight-motion", "MOTION CHECK", "waiting");
    setPreflightItem("preflight-screen", "SCREEN CHECK", "waiting");
    setPreflightItem("preflight-pocket", "POCKET ARMING", "waiting");
    updateBatteryDisplay();
    setConnection("phone-connection", "WAITING FOR MOTION", "warning");
    setConnection("screen-connection", "CHECKING SCREEN", "warning");
    window.addEventListener("devicemotion", onDeviceMotion);
    snapshot = {
      ...coach.start(sessionStartedAtMs),
      status: "PREFLIGHT",
      message: "Checking phone motion and screen-awake protection."
    };
    formSnapshot = formAnalyzer.start(sessionStartedAtMs);
    render(true);
    startResilienceMonitor();
    persistActiveSession(true);
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

async function resumeSavedSession() {
  const restored = savedSession || parsePersistedSession(readStoredText(activeSessionStorageKey));
  if (!restored) {
    clearPersistedSession();
    render(true);
    return;
  }
  try {
    await requestMotionPermission();
    detector = new HipMotionCadenceDetector();
    fusion = new RunSignalFusion();
    coach = new RunRhythmCoach();
    formAnalyzer = new HipFormAnalyzer();
    const now = performance.now();
    snapshot = coach.restoreState(restored.coachState, now);
    formSnapshot = restored.formState ? formAnalyzer.restoreState(restored.formState, now) : formAnalyzer.start(now);
    pocketSide = restored.pocketSide === "left" ? "left" : "right";
    active = true;
    fieldSession = true;
    sessionStartedAtEpochMs = restored.startedAtEpochMs;
    sessionStartedAtMs = now - Math.max(0, Date.now() - restored.startedAtEpochMs);
    interruptions = [...restored.interruptions];
    interruptionActive = interruptions.at(-1)?.endedAtEpochMs == null ? interruptions.at(-1) : null;
    motionSignalConfirmed = false;
    preflightConfirmed = false;
    preflightAnnounced = true;
    lastMotionAtMs = null;
    savedSession = null;
    if (!interruptionActive) {
      interruptions.push(createInterruption({ reason: "app-restarted", startedAtEpochMs: restored.savedAtEpochMs }));
      interruptionActive = interruptions.at(-1);
    }
    setConnection("phone-connection", "WAITING FOR MOTION", "warning");
    setConnection("screen-connection", "RECOVERING SCREEN", "warning");
    setPreflightItem("preflight-motion", "MOTION CHECK", "waiting");
    setPreflightItem("preflight-screen", "SCREEN CHECK", "waiting");
    setPreflightItem("preflight-pocket", "POCKET ARMING", "waiting");
    window.addEventListener("devicemotion", onDeviceMotion);
    render(true);
    startResilienceMonitor();
    await requestWakeLock();
    motionSignalTimeout = setTimeout(() => {
      if (active && !motionSignalConfirmed) setConnection("phone-connection", "NO MOTION YET", "warning");
    }, 6_000);
    speak("Saved run restored. Move the phone to confirm motion, then pocket lock will reactivate.");
    persistActiveSession(true);
  } catch (error) {
    snapshot = { ...snapshot, status: "SENSOR ERROR", message: error?.message || "The saved run could not resume.", events: [] };
    render(true);
  }
}

function finishSession() {
  if (!active) return;
  setPocketLock(false);
  pendingFinishUntil = -Infinity;
  clearMotionTimeout();
  lastSessionElapsedMs = sessionStartedAtMs === null ? 0 : Math.max(0, snapshot.timestampMs - sessionStartedAtMs);
  if (interruptionActive) endInterruption();
  const interruptionData = interruptionSummary(interruptions);
  formSnapshot = formAnalyzer.snapshot(performance.now(), { force: true });
  let completedSaved = !fieldSession;
  if (fieldSession) {
    const completedPayload = {
      version: 1,
      completedAtEpochMs: Date.now(),
      pocketSide,
      snapshot: formSnapshot
    };
    completedSaved = writeStoredJson(completedFormStorageKey, completedPayload);
    if (completedSaved) completedFormReport = completedPayload;
  }
  active = false;
  fieldSession = false;
  preflightConfirmed = false;
  sessionStartedAtMs = null;
  sessionStartedAtEpochMs = null;
  window.removeEventListener("devicemotion", onDeviceMotion);
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = null;
  stopResilienceMonitor();
  if (completedSaved) clearPersistedSession();
  releaseWakeLock();
  const interruptionNote = interruptionData.count
    ? ` Recording was interrupted ${interruptionData.count} ${interruptionData.count === 1 ? "time" : "times"} for about ${formatMinutes(interruptionData.totalMs)}.`
    : " Recording remained continuous.";
  const summary = `Field test complete. ${snapshot.stablePercent} percent of running time was inside your rhythm band. ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}. Longest steady block ${formatMinutes(snapshot.longestStableBlockMs)}.${interruptionNote}`;
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
  formAnalyzer = new HipFormAnalyzer();
  active = true;
  fieldSession = false;
  motionSignalConfirmed = false;
  preflightConfirmed = false;
  demoStartedAt = performance.now();
  sessionStartedAtMs = demoStartedAt;
  lastSessionElapsedMs = 0;
  handleSnapshot(coach.start(demoStartedAt));
  formSnapshot = formAnalyzer.start(demoStartedAt);
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

async function setPocketLock(locked, { announce = true } = {}) {
  pocketLocked = Boolean(locked && active);
  els["pocket-lock-screen"].hidden = !pocketLocked;
  doc.querySelector(".run-shell").inert = pocketLocked;
  doc.body.classList.toggle("pocket-locked", pocketLocked);
  cancelPocketUnlock();
  if (pocketLocked) {
    await requestWakeLock();
    try { await doc.documentElement.requestFullscreen?.({ navigationUI: "hide" }); } catch (_) {}
    setPreflightItem("preflight-pocket", "POCKET LOCKED", "ready");
    if (announce) reply("Pocket lock on. Press and hold the unlock button for two seconds to unlock.");
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
els["resume-session"].addEventListener("click", resumeSavedSession);
els["stop-session"].addEventListener("click", finishSession);
els["demo-session"].addEventListener("click", startDemo);
els["planned-walk"].addEventListener("click", () => handleSnapshot(coach.markPlannedBreak(performance.now())));
els["resume-run"].addEventListener("click", resumeRunning);
els["speak-status"].addEventListener("click", () => reply(statusSentence()));
els["silence-coach"].addEventListener("click", toggleVoicePrompts);
els["start-vibration"].addEventListener("click", toggleStartVibration);
els["pocket-side-left"].addEventListener("click", () => setPocketSide("left"));
els["pocket-side-right"].addEventListener("click", () => setPocketSide("right"));
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
  if (!active || !fieldSession) return;
  if (document.visibilityState === "visible") {
    requestWakeLock();
  } else {
    beginInterruption("app-hidden");
    persistActiveSession(true);
  }
});
for (const eventName of ["touchmove", "wheel", "gesturestart", "gesturechange", "gestureend", "contextmenu"]) {
  document.addEventListener(eventName, event => {
    if (pocketLocked) event.preventDefault();
  }, { passive: false });
}
window.addEventListener("pagehide", () => persistActiveSession(true));
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
renderStartVibration();
renderPocketSide();
initialiseBatteryCheck();
initialiseStorageCheck();
if (savedSession) {
  snapshot = { ...snapshot, status: "SAVED RUN", message: "A previous run can be resumed without losing its recorded summary.", events: [] };
} else if (completedFormReport?.version === 1 && completedFormReport.snapshot) {
  formSnapshot = completedFormReport.snapshot;
  pocketSide = completedFormReport.pocketSide === "left" ? "left" : "right";
}
render(true);
