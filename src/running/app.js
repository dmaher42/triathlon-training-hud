import { HipMotionCadenceDetector } from "./motion-cadence.js";
import { RunRhythmCoach } from "./rhythm-engine.js";
import { RunSignalFusion } from "./signal-fusion.js";
import { BrowserVoiceController, VOICE_INTENTS, parseVoiceCommand } from "./voice-commands.js";
import { createRunControlAck, normaliseRunControlAction, normaliseRunControlMessage } from "./control-protocol.js";
import { HipFormAnalyzer } from "./hip-form-analyzer.js";
import { ArmSwingAnalyzer } from "./arm-swing-analyzer.js";
import {
  DEFAULT_TECHNIQUE_WINDOW_MS, RUN_TERRAINS, TECHNIQUE_WINDOW_OPTIONS_MS, TechniqueLapEngine
} from "./technique-lap-engine.js";
import {
  closeInterruption, createInterruption, interruptionSummary,
  makeCompletedRun, makePersistedSession, parseCompletedRun, parsePersistedSession
} from "./session-resilience.js";
import { planActivePlacementSwitch, runConfigurationLocked, selectRunConfiguration } from "./run-configuration.js";

const doc = document;
const els = Object.fromEntries([
  "run-shell", "finish-dialog", "finish-dialog-description", "finish-cancel", "finish-confirm",
  "save-result", "save-result-title", "save-result-message", "retry-save",
  "status-card", "status-value", "status-message", "status-glyph",
  "terrain-chip", "run-context-summary",
  "baseline-progress", "baseline-mini-progress", "baseline-track",
  "cadence-value", "cadence-target", "cadence-delta", "baseline-value", "baseline-state",
  "baseline-summary", "stable-value", "stability-summary", "summary-state", "session-time", "walk-value", "stop-value", "interruption-value",
  "phone-connection", "garmin-connection", "screen-connection", "install-app", "start-session", "stop-session", "primary-controls", "run-controls",
  "mark-change", "mark-change-label", "mark-change-detail", "planned-walk", "resume-run", "speak-status", "silence-coach", "start-vibration", "demo-session", "voice-status",
  "voice-dock", "voice-help", "voice-mode", "voice-subtitle", "voice-toggle", "voice-prompts-toggle",
  "pocket-lock", "pocket-lock-screen", "pocket-unlock", "pocket-unlock-progress", "resume-session",
  "preflight-panel", "preflight-motion", "preflight-screen", "preflight-pocket", "preflight-battery", "preflight-save",
  "form-lab", "form-vertical", "form-horizontal", "form-rotation", "form-impact",
  "form-status", "form-confidence", "form-progress", "pocket-side-left", "pocket-side-right",
  "form-segment-review", "form-middle", "form-late", "placement-hip", "placement-hand",
  "form-lab-title", "form-lab-note", "form-side-label", "form-boundary", "view-last-run", "placement-switch", "placement-switch-status", "hand-mode-note", "metric-grid", "form-progress-track",
  "form-label-vertical", "form-label-horizontal", "form-label-rotation", "form-label-impact",
  "pocket-lock-label"
  , "technique-panel", "technique-confidence", "technique-panel-title", "technique-panel-message",
  "technique-report", "technique-report-count", "technique-report-list", "technique-retrospective",
  "technique-retrospective-title", "technique-retrospective-confidence", "technique-retrospective-content",
  "terrain-dialog", "terrain-dialog-close"
].map(id => [id, doc.getElementById(id)]));

let detector = new HipMotionCadenceDetector();
let fusion = new RunSignalFusion();
let coach = new RunRhythmCoach();
let formAnalyzer = new HipFormAnalyzer();
let formSnapshot = formAnalyzer.snapshot(0);
let armAnalyzer = new ArmSwingAnalyzer();
let armSnapshot = armAnalyzer.snapshot(0);
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
let finishReturnFocus = null;
const voicePromptsStorageKey = "run-durability-voice-prompts-v1";
let voicePromptsEnabled = readStoredText(voicePromptsStorageKey) !== "off";
const startVibrationStorageKey = "run-durability-start-vibration-v1";
let startVibrationEnabled = readStoredText(startVibrationStorageKey) !== "off";
const activeSessionStorageKey = "run-durability-active-session-v1";
// Keep the legacy storage key so existing last-motion reports upgrade in place.
const completedRunStorageKey = "run-durability-completed-form-v1";
let pocketLocked = false;
let pocketUnlockTimer = null;
let lockReturnFocus = null;
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
const phonePlacementStorageKey = "run-durability-phone-placement-v1";
let phonePlacement = readStoredText(phonePlacementStorageKey) === "hand" ? "hand" : "hip";
let placementSwitchCount = Number.isFinite(Number(savedSession?.placementSwitchCount))
  ? Math.max(0, Math.floor(Number(savedSession.placementSwitchCount)))
  : 0;
let completedFormReport = parseCompletedRun(readStoredText(completedRunStorageKey));
let showingCompletedReport = Boolean(completedFormReport?.completedAtEpochMs && completedFormReport?.snapshot);
let completedSaveState = "idle";
let pendingCompletedRun = null;
const terrainStorageKey = "run-durability-terrain-v1";
const comparisonWindowStorageKey = "run-durability-technique-window-v1";
const storedTerrain = readStoredText(terrainStorageKey);
const storedComparisonWindowMs = Number(readStoredText(comparisonWindowStorageKey));
let currentTerrain = RUN_TERRAINS.includes(savedSession?.terrain)
  ? savedSession.terrain
  : RUN_TERRAINS.includes(storedTerrain) ? storedTerrain : "unlabelled";
let comparisonWindowMs = TECHNIQUE_WINDOW_OPTIONS_MS.includes(savedSession?.comparisonWindowMs)
  ? savedSession.comparisonWindowMs
  : TECHNIQUE_WINDOW_OPTIONS_MS.includes(storedComparisonWindowMs)
    ? storedComparisonWindowMs
    : DEFAULT_TECHNIQUE_WINDOW_MS;
let techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
let techniqueSnapshot = techniqueEngine.snapshot(0);
let latestRetrospectiveComparison = null;
let lastTechniqueExperimentCount = 0;
let techniqueDemoScale = 1;
let techniqueDemoOffsetMs = 0;
let demoPreviousComparisonWindowMs = null;
let lastTechniqueRecordedElapsedMs = -Infinity;
if (savedSession && completedFormReport?.completedAtEpochMs >= savedSession.savedAtEpochMs) {
  savedSession = null;
  try { localStorage.removeItem(activeSessionStorageKey); } catch (_) {}
}
if (savedSession) {
  phonePlacement = savedSession.phonePlacement === "hand" ? "hand" : "hip";
  pocketSide = savedSession.pocketSide === "left" ? "left" : "right";
  showingCompletedReport = false;
}

function toneFor(status) {
  if (status === "STEADY") return "success";
  if (["ARM LIVE", "ARM CHECK"].includes(status)) return "arm";
  if (["FADING", "WALKING", "PLANNED WALK", "PLANNED STOP"].includes(status)) return "attention";
  if (["STOPPED", "SENSOR ERROR"].includes(status)) return "stopped";
  return "ready";
}

function formatMinutes(milliseconds) {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const TERRAIN_LABELS = Object.freeze({
  unlabelled: "Unlabelled",
  flat: "Flat",
  uphill: "Uphill",
  downhill: "Downhill",
  rolling: "Rolling",
  trail: "Trail / uneven",
  treadmill: "Treadmill"
});

const TECHNIQUE_METRIC_LABELS = Object.freeze({
  cadenceSpm: "Cadence",
  rhythmStabilityPercent: "Rhythm stability",
  hipVerticalIndex: "Bounce index",
  hipHorizontalIndex: "Horizontal index",
  hipRotationIndex: "Rotation index",
  hipImpactVariationIndex: "Impact variation",
  armCycleRpm: "Arm cycles",
  armRegularityPercent: "Arm regularity",
  armRangeIndex: "Swing range"
});

function terrainLabel(terrain = currentTerrain) {
  return TERRAIN_LABELS[terrain] || TERRAIN_LABELS.unlabelled;
}

function techniqueWindowMinutes(windowMs = comparisonWindowMs) {
  return Math.round(windowMs / 60_000);
}

function runElapsedAt(now = performance.now()) {
  if (sessionStartedAtMs === null) return techniqueSnapshot?.elapsedMs || 0;
  return Math.max(0, now - sessionStartedAtMs);
}

function techniqueElapsedAt(now = performance.now()) {
  const displayElapsedMs = runElapsedAt(now);
  const scaled = techniqueDemoOffsetMs + displayElapsedMs * techniqueDemoScale;
  return Math.max(0, Math.floor(scaled / 1_000) * 1_000);
}

function currentMotionTechniqueMetrics(now = performance.now()) {
  const bucketStartMs = Math.floor(now / 1_000) * 1_000;
  const bucketEndMs = bucketStartMs + 1_000;
  try {
    const result = phonePlacement === "hand"
      ? armAnalyzer.windowMetrics(bucketStartMs, bucketEndMs)
      : formAnalyzer.windowMetrics(bucketStartMs, bucketEndMs);
    const metrics = result.metrics || {};
    if (phonePlacement === "hand") {
      return {
        armCycleRpm: metrics.armCycleRpm,
        armRegularityPercent: metrics.regularityPercent,
        armRangeIndex: metrics.rangeMean
      };
    }
    return {
      hipVerticalIndex: metrics.verticalRms,
      hipHorizontalIndex: metrics.horizontalRms,
      hipRotationIndex: metrics.rotationRms,
      hipImpactVariationIndex: metrics.impactVariation
    };
  } catch (_) {
    return {};
  }
}

function techniqueChangePhrase(change, label) {
  if (!change || !Number.isFinite(change.absolute)) return null;
  const magnitude = Math.abs(change.absolute);
  const rounded = label === "Cadence" ? Math.round(magnitude) : Math.round(magnitude * 10) / 10;
  const unit = change.unit === "percentage-points" ? " points" : label === "Cadence" ? " steps per minute" : "";
  return `${label} ${rounded}${unit} ${change.direction}`;
}

function techniqueCompletionSentence(comparison) {
  if (!comparison || comparison.status !== "complete") return "Technique comparison saved with incomplete coverage.";
  const preferred = ["cadenceSpm", "rhythmStabilityPercent", phonePlacement === "hand" ? "armRegularityPercent" : "hipVerticalIndex"];
  const phrases = preferred
    .map(key => techniqueChangePhrase(comparison.changes?.[key], TECHNIQUE_METRIC_LABELS[key]))
    .filter(Boolean)
    .slice(0, 2);
  const result = phrases.length ? phrases.join(". ") : "There was not enough comparable running data for a clear change.";
  const warning = comparison.quality === "high" ? "" : " Context or coverage changed, so treat this as an observation, not proof of improvement.";
  return `Comparison ready. ${result}.${warning}`;
}

function detectTechniqueExperimentChange({ announce = true } = {}) {
  const experiments = techniqueEngine.getCompletedComparisons();
  if (experiments.length <= lastTechniqueExperimentCount) return null;
  const latest = experiments.at(-1);
  lastTechniqueExperimentCount = experiments.length;
  if (announce && latest?.status === "complete") {
    navigator.vibrate?.([90, 90, 90]);
    speak(techniqueCompletionSentence(latest));
  }
  return latest;
}

function recordTechniqueFrame(signal, coachSnapshot, now = performance.now()) {
  if (!active || sessionStartedAtMs === null) return;
  const elapsedMs = techniqueElapsedAt(now);
  if (elapsedMs <= lastTechniqueRecordedElapsedMs) return;
  lastTechniqueRecordedElapsedMs = elapsedMs;
  const baseline = Number.isFinite(coachSnapshot.baselineCadenceSpm) ? coachSnapshot.baselineCadenceSpm : null;
  const cadence = Number.isFinite(signal.cadenceSpm) ? signal.cadenceSpm : null;
  const rhythmStable = baseline === null || cadence === null
    ? null
    : cadence >= baseline * (1 - (coach.config?.driftRatio ?? 0.06));
  techniqueSnapshot = techniqueEngine.recordFrame({
    elapsedMs,
    movementState: signal.movementState,
    eligible: (!fieldSession || preflightConfirmed) && !coachSnapshot.plannedBreakActive,
    interrupted: Boolean(interruptionActive),
    cadenceSpm: cadence,
    rhythmStable,
    heartRateBpm: signal.heartRateBpm,
    speedMps: signal.speedMps,
    metrics: currentMotionTechniqueMetrics(Math.max(0, now - 1_000)),
    placement: phonePlacement,
    side: pocketSide,
    cadenceSource: signal.cadenceSource,
    sensorSource: phonePlacement === "hand"
      ? armSnapshot.capabilities?.signalSource || "phone-motion"
      : "phone-motion"
  });
  detectTechniqueExperimentChange();
}

function advanceTechniqueClock(now = performance.now(), { announce = true } = {}) {
  if (!active || sessionStartedAtMs === null) return techniqueSnapshot;
  techniqueSnapshot = techniqueEngine.tick(techniqueElapsedAt(now));
  detectTechniqueExperimentChange({ announce });
  return techniqueSnapshot;
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

function applyRunConfiguration({ placement, side } = {}) {
  const reviewingCompletedReport = showingCompletedReport && Boolean(completedFormReport?.snapshot);
  const leavingReview = snapshot.status === "REVIEW";
  const next = selectRunConfiguration({
    currentPlacement: phonePlacement,
    currentSide: pocketSide,
    reviewingCompletedReport,
    reportPlacement: completedReportPlacement(),
    reportSide: completedFormReport?.pocketSide,
    selectedPlacement: placement,
    selectedSide: side
  });
  phonePlacement = next.placement;
  pocketSide = next.side;
  writeStoredText(phonePlacementStorageKey, phonePlacement);
  writeStoredText(pocketSideStorageKey, pocketSide);
  showingCompletedReport = false;
  if (leavingReview) {
    completedSaveState = "idle";
    resetReadySession();
  }
  resetSelectedMeasurement();
}

function resetReadySession() {
  if (demoPreviousComparisonWindowMs !== null) {
    comparisonWindowMs = demoPreviousComparisonWindowMs;
    demoPreviousComparisonWindowMs = null;
  }
  detector = new HipMotionCadenceDetector();
  fusion = new RunSignalFusion();
  coach = new RunRhythmCoach();
  snapshot = coach.snapshot(0);
  lastSessionElapsedMs = 0;
  interruptions = [];
  interruptionActive = null;
  placementSwitchCount = 0;
  techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
  techniqueSnapshot = techniqueEngine.snapshot(0);
  latestRetrospectiveComparison = null;
  lastTechniqueExperimentCount = 0;
  techniqueDemoScale = 1;
  techniqueDemoOffsetMs = 0;
  lastTechniqueRecordedElapsedMs = -Infinity;
}

function renderTechniqueSetup() {
  const minutes = techniqueWindowMinutes();
  const context = `${terrainLabel().toUpperCase()} · ${minutes}-MIN COMPARE`;
  els["run-context-summary"].textContent = context;
  els["terrain-chip"].textContent = `${terrainLabel().toUpperCase()} · ${minutes} MIN`;
  for (const button of doc.querySelectorAll("[data-terrain-option]")) {
    button.setAttribute("aria-pressed", String(button.dataset.terrainOption === currentTerrain));
  }
  for (const button of doc.querySelectorAll("[data-window-minutes]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.windowMinutes) === minutes));
    button.disabled = active;
  }
}

function setTechniqueWindow(windowMs, { announce = false } = {}) {
  if (!TECHNIQUE_WINDOW_OPTIONS_MS.includes(windowMs)) return false;
  const result = techniqueEngine.setWindowMs(windowMs);
  if (!result.changed && active) {
    if (announce) reply("Finish or cancel the active comparison before changing its window.");
    return false;
  }
  comparisonWindowMs = windowMs;
  writeStoredText(comparisonWindowStorageKey, String(windowMs));
  techniqueSnapshot = techniqueEngine.snapshot(techniqueSnapshot?.elapsedMs || 0);
  renderTechniqueSetup();
  render(true);
  if (announce) reply(`Technique comparison window set to ${techniqueWindowMinutes()} minutes.`);
  return true;
}

function setTerrainContext(terrain, { announce = false, source = "touch" } = {}) {
  if (!RUN_TERRAINS.includes(terrain)) return false;
  currentTerrain = terrain;
  writeStoredText(terrainStorageKey, terrain);
  if (active) {
    techniqueEngine.setTerrain(terrain, techniqueElapsedAt(), { source });
    techniqueSnapshot = techniqueEngine.snapshot(techniqueElapsedAt());
    persistActiveSession(true);
  } else if (snapshot.status !== "REVIEW") {
    techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
    techniqueSnapshot = techniqueEngine.snapshot(0);
  }
  renderTechniqueSetup();
  render(true);
  if (els["terrain-dialog"].open) els["terrain-dialog"].close();
  if (announce) reply(`Terrain set to ${terrainLabel()}. Measurements from this point use that label.`);
  return true;
}

function openTerrainDialog() {
  if (!active && snapshot.status === "REVIEW") return;
  els["terrain-dialog"].showModal();
  const selected = els["terrain-dialog"].querySelector(`[data-terrain-option="${currentTerrain}"]`);
  selected?.focus();
}

function setRunConfiguration({ placement, side } = {}) {
  if (active || savedSession || pendingCompletedRun) return;
  applyRunConfiguration({ placement, side });
  render(true);
}

function setPocketSide(side) {
  setRunConfiguration({ side });
}

function setPhonePlacement(placement) {
  if (active) return switchActivePlacement(placement);
  setRunConfiguration({ placement });
  return true;
}

function placementName(placement) {
  return placement === "hand" ? "Hand swing" : "Hip pocket";
}

function switchActivePlacement(requestedPlacement, { forceReply = false } = {}) {
  const transition = planActivePlacementSwitch({
    active,
    pocketLocked,
    currentPlacement: phonePlacement,
    requestedPlacement
  });

  if (!transition.changed) {
    if (forceReply) {
      if (transition.blockedReason === "inactive") reply("Start the run before switching phone position.");
      else if (transition.blockedReason === "locked") reply(`Unlock ${phonePlacement === "hand" ? "Run Lock" : "Pocket Lock"} before switching phone position.`);
      else reply(`${placementName(phonePlacement)} measurement is already active.`);
    }
    return false;
  }

  const now = performance.now();
  const cancelledTechnique = techniqueSnapshot?.active
    ? techniqueEngine.cancelActive(techniqueElapsedAt(now), "placement-changed")
    : null;
  if (cancelledTechnique) {
    techniqueSnapshot = techniqueEngine.snapshot(techniqueElapsedAt(now));
    detectTechniqueExperimentChange({ announce: false });
  }
  if (phonePlacement === "hand") armSnapshot = armAnalyzer.snapshot(now, { force: true });
  else formSnapshot = formAnalyzer.snapshot(now, { force: true });

  phonePlacement = transition.placement;
  writeStoredText(phonePlacementStorageKey, phonePlacement);
  if (phonePlacement === "hand") {
    armAnalyzer = new ArmSwingAnalyzer();
    armSnapshot = armAnalyzer.start(now);
  } else {
    detector = new HipMotionCadenceDetector();
    formAnalyzer = new HipFormAnalyzer();
    formSnapshot = formAnalyzer.start(now);
  }

  fusion.updatePhone({ timestampMs: now, cadenceSpm: null, movementState: "unknown", motionIntensity: null });
  placementSwitchCount += 1;

  if (fieldSession) {
    motionSignalConfirmed = false;
    preflightConfirmed = false;
    preflightAnnounced = true;
    lastMotionAtMs = now;
    clearMotionTimeout();
    setConnection("phone-connection", "MOVE PHONE TO CONFIRM", "warning");
    setPreflightItem("preflight-motion", phonePlacement === "hand" ? "HAND MOTION CHECK" : "HIP MOTION CHECK", "waiting");
    setPreflightItem("preflight-pocket", phonePlacement === "hand" ? "RUN LOCK ARMING" : "POCKET LOCK ARMING", "waiting");
    motionSignalTimeout = setTimeout(() => {
      if (!active || !fieldSession || motionSignalConfirmed) return;
      setConnection("phone-connection", phonePlacement === "hand" ? "NO HAND MOTION YET" : "NO HIP MOTION YET", "warning");
      setPreflightItem("preflight-motion", "MOTION STILL WAITING", "warning");
      render(true);
    }, 6_000);
  }

  persistActiveSession(true);
  render(true);
  const message = `${placementName(phonePlacement)} selected. New measurement segment started.${cancelledTechnique ? " The active technique comparison was cancelled because the phone moved." : ""}`;
  els["placement-switch-status"].textContent = message;
  if (forceReply) reply(message);
  else speak(message);
  return true;
}

function viewCompletedReport() {
  if (active || savedSession || pendingCompletedRun || !completedFormReport?.snapshot) return;
  restoreCompletedReport();
  render(true);
}

function handlePrimaryStartAction() {
  if (!active && snapshot.status === "REVIEW") {
    if (pendingCompletedRun) return;
    applyRunConfiguration();
    render(true);
    return;
  }
  startSession();
}

function resetSelectedMeasurement() {
  if (phonePlacement === "hand") {
    armAnalyzer = new ArmSwingAnalyzer();
    armSnapshot = armAnalyzer.snapshot(0);
  } else {
    formAnalyzer = new HipFormAnalyzer();
    formSnapshot = formAnalyzer.snapshot(0);
  }
}

function completedReportPlacement(report = completedFormReport) {
  return report?.phonePlacement === "hand" ? "hand" : "hip";
}

function restoreCompletedReport() {
  if (!completedFormReport?.snapshot) return false;
  phonePlacement = completedReportPlacement();
  pocketSide = completedFormReport.pocketSide === "left" ? "left" : "right";
  if (phonePlacement === "hand") armSnapshot = completedFormReport.snapshot;
  else formSnapshot = completedFormReport.snapshot;
  if (completedFormReport.runSnapshot) {
    snapshot = { ...completedFormReport.runSnapshot, status: "REVIEW", events: [] };
    lastSessionElapsedMs = completedFormReport.elapsedMs;
    interruptions = completedFormReport.interruptions;
    interruptionActive = null;
  }
  if (TECHNIQUE_WINDOW_OPTIONS_MS.includes(completedFormReport.comparisonWindowMs)) {
    comparisonWindowMs = completedFormReport.comparisonWindowMs;
  }
  const reportTerrain = completedFormReport.terrainSegments?.at(-1)?.terrain;
  if (RUN_TERRAINS.includes(reportTerrain)) currentTerrain = reportTerrain;
  latestRetrospectiveComparison = completedFormReport.retrospectiveComparison || null;
  showingCompletedReport = true;
  completedSaveState = pendingCompletedRun ? "failed" : "saved";
  return true;
}

function renderCompletedSaveState() {
  const visible = !active
    && showingCompletedReport
    && ["saved", "failed"].includes(completedSaveState);
  els["save-result"].hidden = !visible;
  if (!visible) return;
  const failed = completedSaveState === "failed";
  els["save-result"].dataset.state = failed ? "failed" : "saved";
  els["save-result-title"].textContent = failed ? "SAVE FAILED" : "RUN SAVED";
  els["save-result-message"].textContent = failed
    ? "Your review is still on this screen. Keep it open and retry."
    : "Complete review saved on this phone.";
  els["retry-save"].hidden = !failed;
}

function renderPhonePlacement({ placement = phonePlacement, side = pocketSide } = {}) {
  const controlsLocked = runConfigurationLocked({ active, hasSavedSession: Boolean(savedSession) });
  els["placement-hip"].setAttribute("aria-pressed", String(placement === "hip"));
  els["placement-hand"].setAttribute("aria-pressed", String(placement === "hand"));
  els["placement-hip"].disabled = controlsLocked;
  els["placement-hand"].disabled = controlsLocked;
  for (const candidateSide of ["left", "right"]) {
    els[`pocket-side-${candidateSide}`].setAttribute("aria-pressed", String(side === candidateSide));
    els[`pocket-side-${candidateSide}`].disabled = controlsLocked;
    els[`pocket-side-${candidateSide}`].textContent = `${candidateSide.toUpperCase()} ${placement === "hand" ? "HAND" : "HIP"}`;
  }
  els["form-side-label"].textContent = placement === "hand" ? "PHONE HAND" : "POCKET SIDE";
  els["pocket-lock-label"].textContent = placement === "hand" ? "RUN LOCKED" : "POCKET LOCKED";
  els["pocket-lock"].querySelector("strong").textContent = placement === "hand" ? "RUN LOCK" : "POCKET LOCK";
  els["pocket-lock-screen"].setAttribute(
    "aria-label",
    `${placement === "hand" ? "Run lock" : "Pocket lock"} active; live dashboard remains visible`
  );
  els["hand-mode-note"].hidden = placement !== "hand";
  const switchDestination = placement === "hand" ? "hip" : "hand";
  els["placement-switch"].hidden = !active;
  els["placement-switch"].disabled = !active || pocketLocked;
  els["placement-switch"].dataset.destination = switchDestination;
  els["placement-switch"].textContent = switchDestination === "hand" ? "SWITCH TO HAND" : "SWITCH TO HIP";
  els["placement-switch"].setAttribute("aria-label", switchDestination === "hand"
    ? "Switch phone measurement to hand swing"
    : "Switch phone measurement to hip pocket");
  doc.body.dataset.phonePlacement = placement;
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

function armSegmentReviewLabel(label, drift) {
  if (!drift || !Number.isFinite(drift.rangePercent)) return `${label} —`;
  return `${label} RANGE ${formatFormChange(drift.rangePercent)}`;
}

function renderFormLab() {
  const reviewScreen = !active && snapshot.status === "REVIEW";
  const isReview = reviewScreen && showingCompletedReport && Boolean(completedFormReport?.snapshot);
  const reportAvailable = !active && !savedSession && !pendingCompletedRun && Boolean(completedFormReport?.snapshot);
  const viewLastRunAvailable = reportAvailable && !reviewScreen;
  const displayPlacement = isReview ? completedReportPlacement() : phonePlacement;
  const displaySide = isReview ? (completedFormReport.pocketSide === "left" ? "left" : "right") : pocketSide;
  renderPhonePlacement({ placement: displayPlacement, side: displaySide });
  const displaySnapshot = isReview
    ? completedFormReport.snapshot
    : displayPlacement === "hand" ? armSnapshot : formSnapshot;
  const handMode = displayPlacement === "hand";
  els["form-lab"].dataset.mode = displayPlacement;
  els["form-lab"].classList.toggle("is-report-review", isReview);
  els["form-lab-title"].textContent = handMode ? "ARM SWING" : "HIP MOTION";
  els["form-lab-note"].textContent = `${displaySide.toUpperCase()} ${handMode ? "HAND" : "HIP"} · ${isReview ? "REVIEW" : active ? "LIVE" : "SETUP"}`;
  els["view-last-run"].hidden = !viewLastRunAvailable;
  els["form-boundary"].hidden = !handMode;
  let formStatus;

  if (handMode) {
    const garminState = fusion.snapshot(performance.now());
    const cycleRate = Number.isFinite(displaySnapshot.armCycleRpm) ? `${Math.round(displaySnapshot.armCycleRpm)}/m` : "—";
    const regularity = Number.isFinite(displaySnapshot.regularityPercent) ? `${displaySnapshot.regularityPercent}%` : "—";
    const range = displaySnapshot.placementConsistent === false
      ? "N/A"
      : displaySnapshot.baselineReady
      ? formatFormChange(displaySnapshot.rangeChangePercent)
      : displaySnapshot.totalSwings ? "LEARN" : "—";
    const cadenceMatch = Number.isFinite(displaySnapshot.cadenceMatchPercent)
      ? `${displaySnapshot.cadenceMatchPercent}%`
      : isReview ? "NO DATA" : garminState.garminConnected ? "WAITING" : "OFFLINE";
    els["form-vertical"].textContent = cycleRate;
    els["form-horizontal"].textContent = regularity;
    els["form-rotation"].textContent = range;
    els["form-impact"].textContent = cadenceMatch;
    els["form-label-vertical"].textContent = "ARM CYCLES";
    els["form-label-horizontal"].textContent = "CYCLE REGULARITY";
    els["form-label-rotation"].textContent = displaySnapshot.capabilities?.signalSource === "acceleration" ? "MOTION SIZE" : "RANGE";
    els["form-label-impact"].textContent = "GARMIN MATCH";
    const switchedPlacement = isReview && Number(completedFormReport?.placementSwitchCount) > 0;
    const reviewStatus = switchedPlacement
      ? displaySnapshot.baselineReady
        ? `Saved ${displaySide} hand final segment · earlier positions excluded`
        : `Saved ${displaySide} hand final segment · insufficient arm baseline`
      : !displaySnapshot.baselineReady
        ? `Saved ${displaySide} hand run · insufficient arm baseline`
      : displaySnapshot.segments?.late
        ? `Saved ${displaySide} hand report · opening, middle and final retained`
        : displaySnapshot.segments?.middle
          ? `Saved ${displaySide} hand report · final section not reached`
          : `Saved ${displaySide} hand baseline · middle section not reached`;
    formStatus = isReview
      ? reviewStatus
      : displaySnapshot.placementConsistent === false
        ? "Grip changed — range unavailable for this run"
        : displaySnapshot.baselineReady
          ? Number.isFinite(displaySnapshot.regularityPercent)
            ? `Arm rhythm ${displaySnapshot.regularityPercent}% regular · range compared with opening`
            : "Arm rhythm settling after the opening baseline"
          : active
            ? `Learning ${displaySide}-hand swing · ${displaySnapshot.baselineProgress || 0}%`
            : "Starts by learning ten minutes of natural arm swing";
    els["form-middle"].textContent = armSegmentReviewLabel("MIDDLE", displaySnapshot.segmentDrift?.middle);
    els["form-late"].textContent = armSegmentReviewLabel("FINAL", displaySnapshot.segmentDrift?.late);
  } else {
    const drift = displaySnapshot.drift || {};
    els["form-vertical"].textContent = formatFormChange(drift.verticalPercent);
    els["form-horizontal"].textContent = formatFormChange(drift.horizontalPercent);
    els["form-rotation"].textContent = displaySnapshot.totalSamples && displaySnapshot.capabilities?.rotationAvailable === false
      ? "N/A"
      : formatFormChange(drift.rotationPercent);
    els["form-impact"].textContent = formatFormChange(drift.impactPercent);
    els["form-label-vertical"].textContent = "BOUNCE";
    els["form-label-horizontal"].textContent = "HORIZONTAL";
    els["form-label-rotation"].textContent = "ROTATION";
    els["form-label-impact"].textContent = "IMPACT";
    const switchedPlacement = isReview && Number(completedFormReport?.placementSwitchCount) > 0;
    const reviewStatus = switchedPlacement
      ? displaySnapshot.baselineReady
        ? `Saved ${displaySide} hip final segment · earlier positions excluded`
        : `Saved ${displaySide} hip final segment · insufficient comparison data`
      : !displaySnapshot.baselineReady
        ? `Saved ${displaySide} hip run · insufficient data for comparison`
      : displaySnapshot.segments?.late
        ? `Saved ${displaySide} hip report · opening, middle and final retained`
        : displaySnapshot.segments?.middle
          ? `Saved ${displaySide} hip report · final section not reached`
          : `Saved ${displaySide} hip baseline · middle section not reached`;
    formStatus = isReview
      ? reviewStatus
      : displaySnapshot.placementConsistent === false
        ? "Phone position changed — measurement confidence reduced"
        : displaySnapshot.baselineReady
          ? displaySnapshot.capabilities?.rotationAvailable === false
            ? "Recent movement compared · rotation unavailable"
            : "Recent five minutes compared with your opening movement"
          : active
            ? `Learning ${displaySide} hip movement · ${displaySnapshot.baselineProgress || 0}%`
            : "Starts by learning ten minutes of running";
    els["form-middle"].textContent = segmentReviewLabel("MIDDLE", displaySnapshot.segmentDrift?.middle);
    els["form-late"].textContent = segmentReviewLabel("FINAL", displaySnapshot.segmentDrift?.late);
  }
  if (els["form-status"].textContent !== formStatus) els["form-status"].textContent = formStatus;
  const formProgress = displaySnapshot.baselineProgress || 0;
  els["form-progress"].style.width = `${formProgress}%`;
  els["form-progress-track"].setAttribute("aria-valuenow", String(formProgress));
  els["form-confidence"].textContent = `${displaySnapshot.confidence || 0}% CONFIDENCE`;
  els["form-segment-review"].hidden = !isReview;
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

function setSaveHealth(healthy, label = healthy ? "SAVE READY" : "SAVE FAILED") {
  setPreflightItem("preflight-save", label, healthy ? "ready" : "warning");
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
  const payload = {
    ...makePersistedSession({
      startedAtEpochMs: sessionStartedAtEpochMs,
      coachState: coach.exportState(),
      formState: formAnalyzer.exportState(),
      armState: armAnalyzer.exportState(),
      phonePlacement,
      pocketSide,
      interruptions,
      techniqueState: techniqueEngine.exportState(),
      terrain: currentTerrain,
      comparisonWindowMs
    }),
    placementSwitchCount
  };
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
    } else if (interruptionActive) {
      endInterruption();
    }
    if (!wakeLock || wakeLock.released) requestWakeLock();
    advanceTechniqueClock(now);
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
  if (["PREFLIGHT", "CALIBRATING", "RESET", "HAND CHECK", "POCKET CHECK"].includes(status)) return "••";
  if (status === "PLANNED WALK") return "Ⅱ";
  return "✓";
}

function armStatusSupplement() {
  const reportIsHand = !active && showingCompletedReport && completedReportPlacement() === "hand";
  if (!(active && phonePlacement === "hand") && !reportIsHand) return "";
  const current = reportIsHand ? completedFormReport.snapshot : armSnapshot;
  const cycle = Number.isFinite(current.armCycleRpm) ? `${Math.round(current.armCycleRpm)} arm cycles per minute` : "arm cycle rate is settling";
  const regularity = Number.isFinite(current.regularityPercent) ? `${current.regularityPercent} percent regular` : "regularity is settling";
  if (!current.baselineReady) {
    return ` Arm swing learning is ${current.baselineProgress || 0} percent complete. Current phone-hand rhythm is ${cycle} and ${regularity}.`;
  }
  const range = Number.isFinite(current.rangeChangePercent)
    ? ` Range is ${Math.abs(current.rangeChangePercent)} percent ${current.rangeChangePercent >= 0 ? "larger" : "smaller"} than your opening pattern.`
    : "";
  const cadenceMatch = Number.isFinite(current.cadenceMatchPercent)
    ? ` Garmin cadence match is ${current.cadenceMatchPercent} percent.`
    : "";
  return ` Arm rhythm is ${cycle} and ${regularity}.${range}${cadenceMatch}`;
}

function statusSentence() {
  const handReport = !active && showingCompletedReport && completedReportPlacement() === "hand";
  const handMode = (active && phonePlacement === "hand") || handReport;
  if (handMode && !Number.isFinite(snapshot.cadenceSpm)) {
    const lead = handReport ? "Saved arm swing report." : "Arm swing monitoring is active.";
    return `${lead} Step cadence needs a live Garmin connection.${armStatusSupplement()} ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}.`;
  }
  const cadence = Number.isFinite(snapshot.cadenceSpm) ? `${Math.round(snapshot.cadenceSpm)} steps per minute` : "cadence is still settling";
  const baseline = Number.isFinite(snapshot.baselineCadenceSpm) ? `Your baseline is ${snapshot.baselineCadenceSpm}` : `Baseline learning is ${snapshot.baselineProgress} percent complete`;
  return `${snapshot.message} Current ${cadence}. ${baseline}. ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}.${armStatusSupplement()}`;
}

function techniqueStatusSentence() {
  if (!active) {
    const completed = completedFormReport?.techniqueComparisons?.filter(item => item.status === "complete") || [];
    return completed.length
      ? `${completed.length} technique ${completed.length === 1 ? "comparison is" : "comparisons are"} saved in the last run review.`
      : "There is no active technique comparison.";
  }
  advanceTechniqueClock();
  if (techniqueSnapshot.active) {
    return `Technique comparison ${techniqueSnapshot.active.sequence} is collecting. ${formatMinutes(techniqueSnapshot.active.remainingMs)} remains.`;
  }
  if (techniqueSnapshot.elapsedMs < techniqueSnapshot.windowMs) {
    return `Technique Lap needs ${formatMinutes(techniqueSnapshot.windowMs - techniqueSnapshot.elapsedMs)} more history before you can mark a change.`;
  }
  const latest = techniqueSnapshot.experiments.at(-1);
  if (latest?.status === "complete") return techniqueCompletionSentence(latest);
  return `Technique Lap is ready. Say mark change to compare the previous ${techniqueWindowMinutes(techniqueSnapshot.windowMs)} minutes with the next ${techniqueWindowMinutes(techniqueSnapshot.windowMs)} minutes.`;
}

function markTechniqueChange({ forceReply = true } = {}) {
  if (!active) {
    if (forceReply) reply("Start the run before marking a technique change.");
    return false;
  }
  if (fieldSession && !preflightConfirmed) {
    if (forceReply) reply("Wait for the motion and screen checks to pass before marking a change.");
    return false;
  }
  advanceTechniqueClock();
  const result = techniqueEngine.markChange(techniqueSnapshot.elapsedMs);
  techniqueSnapshot = techniqueEngine.snapshot(techniqueSnapshot.elapsedMs);
  if (!result.accepted) {
    if (forceReply) {
      reply(result.reason === "comparison-active"
        ? `A technique comparison is already collecting. ${formatMinutes(result.remainingMs)} remains.`
        : `Keep running for ${formatMinutes(result.remainingMs)} before marking a change.`);
    }
    render(true);
    return false;
  }
  navigator.vibrate?.(120);
  persistActiveSession(true);
  render(true);
  if (forceReply) reply(`Change marked. Comparing the next ${techniqueWindowMinutes(result.active.windowMs)} minutes.`);
  return true;
}

function cancelTechniqueComparison({ forceReply = true, reason = "runner-cancelled" } = {}) {
  if (!active || !techniqueSnapshot.active) {
    if (forceReply) reply("There is no active technique comparison to cancel.");
    return false;
  }
  const cancelled = techniqueEngine.cancelActive(techniqueElapsedAt(), reason);
  techniqueSnapshot = techniqueEngine.snapshot(techniqueElapsedAt());
  detectTechniqueExperimentChange({ announce: false });
  persistActiveSession(true);
  render(true);
  if (forceReply) reply(`Technique comparison ${cancelled.sequence} cancelled. Your whole run is still recording.`);
  return true;
}

function compareRecentTechnique(windowMinutes = techniqueWindowMinutes(), { forceReply = true } = {}) {
  if (!active) {
    if (forceReply) reply("Start the run before comparing recent technique windows.");
    return null;
  }
  advanceTechniqueClock();
  const result = techniqueEngine.compareLastToPrevious({
    elapsedMs: techniqueSnapshot.elapsedMs,
    windowMs: Number(windowMinutes) * 60_000
  });
  if (!result.available) {
    if (forceReply) reply(`Another ${formatMinutes(result.remainingMs)} of history is needed for that comparison.`);
    return null;
  }
  latestRetrospectiveComparison = result;
  render(true);
  if (forceReply) reply(techniqueCompletionSentence({ ...result, status: "complete" }));
  return result;
}

function showPreviousTechnique(windowMinutes = techniqueWindowMinutes()) {
  const result = compareRecentTechnique(windowMinutes, { forceReply: false });
  if (!result) return false;
  const cadence = result.previous.metrics?.cadenceSpm;
  const rhythm = result.previous.metrics?.rhythmStabilityPercent;
  const readings = [
    Number.isFinite(cadence) ? `cadence averaged ${Math.round(cadence)} steps per minute` : null,
    Number.isFinite(rhythm) ? `rhythm stability was ${Math.round(rhythm)} percent` : null
  ].filter(Boolean);
  reply(`The previous ${windowMinutes} minutes had ${readings.length ? readings.join(" and ") : "insufficient running data"}. Terrain was ${terrainLabel(result.previous.terrain?.primary)}. Coverage was ${result.previous.coveragePercent} percent.`);
  return true;
}

function comparisonWarningText(warnings = []) {
  const labels = {
    "terrain-mismatch": "Terrain changed between the two blocks.",
    "before-terrain-unlabelled": "The before block had no terrain label.",
    "after-terrain-unlabelled": "The after block had no terrain label.",
    "before-terrain-mixed": "The before block crossed terrain segments.",
    "after-terrain-mixed": "The after block crossed terrain segments.",
    "before-variable-terrain": "The before block used variable terrain.",
    "after-variable-terrain": "The after block used variable terrain.",
    "speed-context-changed": "Pace changed enough to affect interpretation.",
    "heart-rate-context-changed": "Heart-rate context changed.",
    "cadence-source-mismatch": "Cadence source changed between blocks.",
    "placement-mismatch": "Phone placement changed between blocks.",
    "after-window-incomplete": "The run ended before the after block finished.",
    "before-low-running-coverage": "The before block contained limited running data.",
    "after-low-running-coverage": "The after block contained limited running data.",
    "before-missing-samples": "The before block has missing sensor samples.",
    "after-missing-samples": "The after block has missing sensor samples."
  };
  return [...new Set(warnings.map(warning => labels[warning]).filter(Boolean))].slice(0, 2).join(" ");
}

function metricDisplay(key, value) {
  if (!Number.isFinite(value)) return "—";
  if (key === "cadenceSpm" || key === "heartRateBpm" || key === "armCycleRpm") return String(Math.round(value));
  if (["rhythmStabilityPercent", "armRegularityPercent"].includes(key)) return `${Math.round(value)}%`;
  return String(Math.round(value * 100) / 100);
}

function comparisonCard(comparison) {
  const card = doc.createElement("article");
  card.className = "technique-comparison-card";
  card.dataset.quality = comparison.quality || "low";
  const header = doc.createElement("header");
  const title = doc.createElement("h3");
  title.textContent = `CHANGE ${comparison.sequence} · ${formatMinutes(comparison.markedAtElapsedMs)}`;
  const quality = doc.createElement("small");
  quality.textContent = comparison.status === "complete" ? `${String(comparison.quality || "low").toUpperCase()} CONFIDENCE` : String(comparison.status || "incomplete").toUpperCase();
  header.append(title, quality);
  const context = doc.createElement("p");
  context.className = "technique-comparison-context";
  context.textContent = `${formatMinutes(comparison.before.startMs)}–${formatMinutes(comparison.before.endMs)} vs ${formatMinutes(comparison.after.startMs)}–${formatMinutes(comparison.after.endMs)} · ${terrainLabel(comparison.before.terrain?.primary)} → ${terrainLabel(comparison.after.terrain?.primary)}`;
  const grid = doc.createElement("div");
  grid.className = "technique-comparison-grid";
  for (const label of ["MEASURE", "BEFORE", "AFTER", "CHANGE"]) {
    const cell = doc.createElement("span");
    cell.textContent = label;
    grid.append(cell);
  }
  const orderedKeys = Object.keys(TECHNIQUE_METRIC_LABELS).filter(key => comparison.changes?.[key]);
  for (const key of orderedKeys) {
    const change = comparison.changes[key];
    const changeText = change.direction === "unchanged"
      ? "SAME"
      : `${change.absolute > 0 ? "+" : ""}${metricDisplay(key, change.absolute)}`;
    for (const value of [TECHNIQUE_METRIC_LABELS[key], metricDisplay(key, change.before), metricDisplay(key, change.after), changeText]) {
      const cell = doc.createElement("span");
      cell.textContent = value;
      grid.append(cell);
    }
  }
  card.append(header, context, grid);
  const warningText = comparisonWarningText(comparison.warnings);
  if (warningText) {
    const warning = doc.createElement("p");
    warning.className = "technique-comparison-warning";
    warning.textContent = warningText;
    card.append(warning);
  }
  return card;
}

function renderTechniqueReport() {
  const reviewing = !active && snapshot.status === "REVIEW";
  const comparisons = showingCompletedReport
    ? completedFormReport?.techniqueComparisons || []
    : techniqueEngine.getCompletedComparisons();
  const retrospective = showingCompletedReport
    ? completedFormReport?.retrospectiveComparison || null
    : latestRetrospectiveComparison;
  const visible = reviewing && (comparisons.length > 0 || retrospective?.available);
  els["technique-report"].hidden = !visible;
  if (!visible) return;
  els["technique-report-count"].textContent = `${comparisons.length} ${comparisons.length === 1 ? "MARK" : "MARKS"}`;
  els["technique-report-list"].replaceChildren(...comparisons.map(comparisonCard));
  els["technique-retrospective"].hidden = !retrospective?.available;
  if (retrospective?.available) {
    const minutes = techniqueWindowMinutes(retrospective.previous.durationMs);
    els["technique-retrospective-title"].textContent = `LAST ${minutes} / PREVIOUS ${minutes}`;
    els["technique-retrospective-confidence"].textContent = `${String(retrospective.quality || "low").toUpperCase()} CONFIDENCE`;
    const cadence = retrospective.changes?.cadenceSpm;
    const rhythm = retrospective.changes?.rhythmStabilityPercent;
    els["technique-retrospective-content"].textContent = [
      cadence ? techniqueChangePhrase(cadence, "Cadence") : null,
      rhythm ? techniqueChangePhrase(rhythm, "Rhythm stability") : null,
      comparisonWarningText(retrospective.warnings)
    ].filter(Boolean).join(" · ") || "Not enough comparable running data.";
  }
}

function renderTechniquePanel() {
  const reviewing = !active && snapshot.status === "REVIEW";
  els["technique-panel"].hidden = !active;
  els["terrain-chip"].disabled = reviewing;
  if (!active) {
    renderTechniqueReport();
    return;
  }
  advanceTechniqueClock(performance.now(), { announce: true });
  const remainingBeforeMs = Math.max(0, techniqueSnapshot.windowMs - techniqueSnapshot.elapsedMs);
  const activeComparison = techniqueSnapshot.active;
  let state = "ready";
  let title = techniqueSnapshot.completedCount ? "READY FOR ANOTHER CHANGE" : "READY TO MARK A CHANGE";
  let message = `Previous ${techniqueWindowMinutes(techniqueSnapshot.windowMs)} vs next ${techniqueWindowMinutes(techniqueSnapshot.windowMs)} minutes · ${terrainLabel()}`;
  let confidence = `${techniqueSnapshot.completedCount} COMPLETE`;
  if (activeComparison) {
    state = "collecting";
    title = `COMPARING · ${formatMinutes(activeComparison.remainingMs)} LEFT`;
    message = `Change ${activeComparison.sequence} · fixed ${techniqueWindowMinutes(activeComparison.windowMs)}-minute after block`;
    confidence = "COLLECTING";
  } else if (remainingBeforeMs > 0) {
    state = "building";
    title = `READY IN ${formatMinutes(remainingBeforeMs)}`;
    message = `Building the previous ${techniqueWindowMinutes(techniqueSnapshot.windowMs)}-minute block`;
    confidence = "HISTORY";
  }
  els["technique-panel"].dataset.state = state;
  els["technique-panel-title"].textContent = title;
  els["technique-panel-message"].textContent = message;
  els["technique-confidence"].textContent = confidence;
  els["mark-change"].dataset.state = state;
  els["mark-change-label"].textContent = activeComparison
    ? `COMPARING · ${formatMinutes(activeComparison.remainingMs)}`
    : remainingBeforeMs > 0
      ? `READY IN ${formatMinutes(remainingBeforeMs)}`
      : techniqueSnapshot.completedCount ? "MARK NEXT CHANGE" : "MARK CHANGE";
  els["mark-change-detail"].textContent = `Previous ${techniqueWindowMinutes(techniqueSnapshot.windowMs)} vs next ${techniqueWindowMinutes(techniqueSnapshot.windowMs)}`;
  renderTechniqueReport();
}

function voiceIdleState() {
  if (voiceController?.state === "unsupported") return ["VOICE UNAVAILABLE", "This browser does not support speech recognition"];
  if (voiceController?.state === "denied") return ["MICROPHONE BLOCKED", "Allow microphone access in Chrome site settings"];
  if (voiceController?.state === "no-microphone") return ["MICROPHONE MISSING", "Chrome could not access a microphone"];
  if (voiceController?.enabled) {
    if (voiceController.listening) return ["VOICE LISTENING", "Say “Coach status” or “Voice help”"];
    return ["VOICE READY", "Listening will resume after the current reply"];
  }
  return ["VOICE OFF", "Tap to enable hands-free controls"];
}

function renderVoiceToggleAccessibility() {
  els["voice-toggle"].setAttribute("aria-label", voiceController?.enabled ? "Disable voice controls" : "Enable voice controls");
}

function setVoiceIdle() {
  const [mode, subtitle] = voiceIdleState();
  els["voice-dock"].dataset.speaking = "false";
  els["voice-dock"].dataset.listening = String(Boolean(voiceController?.listening));
  els["voice-dock"].dataset.voiceError = String(["unsupported", "denied", "no-microphone"].includes(voiceController?.state));
  els["voice-toggle"].setAttribute("aria-pressed", String(Boolean(voiceController?.enabled)));
  renderVoiceToggleAccessibility();
  els["voice-mode"].textContent = mode;
  els["voice-subtitle"].textContent = subtitle;
}

function handleVoiceState({ state, detail }) {
  els["voice-dock"].dataset.listening = String(state === "listening");
  els["voice-dock"].dataset.voiceError = String(["unsupported", "denied", "no-microphone"].includes(state));
  els["voice-toggle"].setAttribute("aria-pressed", String(Boolean(voiceController?.enabled)));
  renderVoiceToggleAccessibility();
  if (state === "listening") {
    els["voice-mode"].textContent = "VOICE LISTENING";
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

  await executeRunIntent(command);
}

async function executeRunIntent(actionOrIntent) {
  const action = typeof actionOrIntent === "string"
    ? { command: actionOrIntent }
    : { ...actionOrIntent, command: actionOrIntent?.command || actionOrIntent?.intent };
  const intent = action.command;
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
    case VOICE_INTENTS.SWITCH_HIP:
      switchActivePlacement("hip", { forceReply: true });
      break;
    case VOICE_INTENTS.SWITCH_HAND:
      switchActivePlacement("hand", { forceReply: true });
      break;
    case VOICE_INTENTS.MARK_CHANGE:
      markTechniqueChange();
      break;
    case VOICE_INTENTS.TECHNIQUE_STATUS:
      reply(techniqueStatusSentence());
      break;
    case VOICE_INTENTS.CANCEL_COMPARISON:
      cancelTechniqueComparison();
      break;
    case VOICE_INTENTS.COMPARE_RECENT:
      compareRecentTechnique(action.windowMinutes);
      break;
    case VOICE_INTENTS.SHOW_PREVIOUS:
      showPreviousTechnique(action.windowMinutes);
      break;
    case VOICE_INTENTS.SET_TERRAIN:
      setTerrainContext(action.terrain, { announce: true, source: "voice" });
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
      reply("You can say mark change, technique status, cancel comparison, compare last five, show previous five, terrain uphill, planned walk, resume running, coach status, prompts off, finish run, or stop listening.");
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

  const fusedState = fusion.snapshot(now);
  const renderedPlacement = !active && showingCompletedReport ? completedReportPlacement() : phonePlacement;
  const handWithoutGarmin = renderedPlacement === "hand" && fusedState.cadenceSource !== "garmin";
  const checkingNewPlacement = active && fieldSession && !motionSignalConfirmed;
  const preserveCoachStatus = ["PLANNED WALK", "PLANNED STOP", "WALKING", "STOPPED", "SENSOR ERROR"].includes(snapshot.status);
  const showArmStatus = active && handWithoutGarmin && !checkingNewPlacement && !preserveCoachStatus;
  const displayStatus = checkingNewPlacement
    ? renderedPlacement === "hand" ? "HAND CHECK" : "POCKET CHECK"
    : showArmStatus
    ? armSnapshot.capabilities?.signalSource ? "ARM LIVE" : "ARM CHECK"
    : snapshot.status;
  const displayMessage = checkingNewPlacement
    ? renderedPlacement === "hand"
      ? "Move the phone with your selected hand to start a fresh arm-swing segment."
      : "Move the phone at your hip to start a fresh hip-motion segment."
    : showArmStatus
    ? armSnapshot.capabilities?.signalSource
      ? `Monitoring ${pocketSide}-hand swing. Garmin is needed for step cadence.`
      : "Move your selected hand naturally while the phone confirms arm motion."
    : snapshot.message;
  els["status-card"].dataset.tone = toneFor(displayStatus);
  els["status-value"].textContent = displayStatus;
  els["status-value"].classList.toggle("is-long", displayStatus.length > 8);
  els["status-message"].textContent = displayMessage;
  els["status-glyph"].textContent = glyphFor(displayStatus);

  const cadence = Number.isFinite(snapshot.cadenceSpm) ? Math.round(snapshot.cadenceSpm) : null;
  const baseline = Number.isFinite(snapshot.baselineCadenceSpm) ? snapshot.baselineCadenceSpm : null;
  const useArmProgress = renderedPlacement === "hand" && baseline === null;
  const progress = useArmProgress
    ? (showingCompletedReport ? completedFormReport?.snapshot?.baselineProgress : armSnapshot.baselineProgress) || 0
    : snapshot.baselineProgress || 0;
  els["baseline-progress"].style.width = `${progress}%`;
  els["baseline-mini-progress"].style.width = `${progress}%`;
  els["baseline-track"].setAttribute("aria-valuenow", String(progress));
  els["baseline-track"].setAttribute("aria-label", useArmProgress ? "Arm swing baseline learning progress" : "Cadence baseline learning progress");

  els["cadence-value"].textContent = cadence ?? "—";
  els["cadence-target"].textContent = baseline ?? "—";
  els["baseline-value"].textContent = baseline ?? "—";
  els["baseline-state"].textContent = baseline
    ? "CONFIRMED"
    : handWithoutGarmin ? fusedState.garminConnected ? "WAITING" : "GARMIN OFFLINE"
    : snapshot.active ? `${progress}%` : "NOT STARTED";
  els["baseline-summary"].textContent = baseline
    ? "Confirmed from your opening natural rhythm"
    : handWithoutGarmin
      ? fusedState.garminConnected ? "Waiting for Garmin step cadence" : "Connect Garmin for step cadence coaching"
      : snapshot.active ? "Learning from steady running samples" : "Starts with two minutes of natural running";

  if (cadence !== null && baseline !== null) {
    const delta = (cadence - baseline) / baseline * 100;
    els["cadence-delta"].textContent = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    els["cadence-delta"].dataset.delta = delta < -3 ? "low" : "good";
  } else {
    els["cadence-delta"].textContent = handWithoutGarmin
      ? fusedState.garminConnected ? "WAITING" : "GARMIN OFFLINE"
      : snapshot.active ? "SETTLING" : "WAITING";
    els["cadence-delta"].dataset.delta = "";
  }

  els["stable-value"].textContent = baseline === null ? "—" : `${snapshot.stablePercent || 0}%`;
  els["stability-summary"].textContent = baseline
    ? snapshot.driftActive ? "Below your personal rhythm band" : `${snapshot.stablePercent || 0}% of running held steady`
    : handWithoutGarmin ? "Requires Garmin step cadence" : snapshot.active ? "Available after the baseline is learned" : "Waiting for your opening rhythm";
  const elapsedMs = active && sessionStartedAtMs !== null
    ? Math.max(0, snapshot.timestampMs - sessionStartedAtMs)
    : lastSessionElapsedMs;
  els["session-time"].textContent = formatMinutes(elapsedMs);
  els["walk-value"].textContent = snapshot.unplannedWalks || 0;
  els["stop-value"].textContent = snapshot.stopCount || 0;
  els["interruption-value"].textContent = interruptionSummary(interruptions).count;
  els["summary-state"].textContent = snapshot.status === "REVIEW" ? "FINAL" : active ? "LIVE" : "READY";
  renderCompletedSaveState();
  const reviewingRun = !active && snapshot.status === "REVIEW";
  els["start-session"].hidden = active || Boolean(savedSession) || Boolean(pendingCompletedRun);
  els["start-session"].textContent = reviewingRun ? "START ANOTHER RUN" : "START RUN";
  els["resume-session"].hidden = active || !savedSession;
  els["stop-session"].hidden = !active;
  els["run-controls"].hidden = !active;
  els["planned-walk"].hidden = !active || Boolean(snapshot.plannedBreakActive);
  els["resume-run"].hidden = !active || !snapshot.plannedBreakActive;
  els["install-app"].hidden = active || isInstalledApp();
  els["demo-session"].hidden = active || !demoEnabled || Boolean(pendingCompletedRun) || reviewingRun;
  doc.body.dataset.session = active ? "active" : snapshot.status === "REVIEW" ? "review" : "ready";
  doc.body.dataset.runPhase = active
    ? fieldSession ? preflightConfirmed ? "live" : "checking" : "demo"
    : "idle";
  els["voice-help"].textContent = active
    ? fieldSession && !preflightConfirmed
      ? phonePlacement === "hand"
        ? "Hold the phone naturally and move your arm while the app confirms motion and screen protection."
        : "Move the phone gently while the app confirms motion and screen protection."
      : voiceController?.enabled
        ? "Hands-free controls are active. Say “Voice help” to hear the commands."
        : "Tap the microphone to enable hands-free commands."
    : voiceController?.supported
      ? "Tap once to enable hands-free commands, then leave the screen open."
      : "Voice commands are unavailable in this browser. Spoken replies still work.";
  if (els["voice-dock"].dataset.speaking !== "true") setVoiceIdle();
  renderTechniqueSetup();
  renderTechniquePanel();
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
  setPreflightItem("preflight-pocket", phonePlacement === "hand" ? "RUN LOCKED" : "POCKET LOCKED", "ready");
  setPocketLock(true, { announce: false });
  render(true);
  if (!preflightAnnounced) {
    preflightAnnounced = true;
    if (startVibrationEnabled) navigator.vibrate?.([120, 80, 180]);
    speak(phonePlacement === "hand"
      ? "Preflight passed. Hold the phone naturally and let your arm swing normally while I learn its rhythm."
      : "Preflight passed. Run naturally while I learn your rhythm.");
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
  const nextSnapshot = coach.update({
    timestampMs: signal.timestampMs,
    cadenceSpm: signal.cadenceSpm,
    movementState: signal.movementState
  });
  recordTechniqueFrame(signal, nextSnapshot, performance.now());
  handleSnapshot(nextSnapshot);
  els["garmin-connection"].classList.toggle("muted", !signal.garminConnected);
  els["garmin-connection"].innerHTML = `<i></i> ${signal.garminConnected ? "GARMIN LIVE" : "GARMIN OFFLINE"}`;
}

function hasMotionVector(event) {
  const vector = event.accelerationIncludingGravity || event.acceleration;
  const accelerationAvailable = Boolean(vector) && [vector.x, vector.y, vector.z].some(value => Number.isFinite(Number(value)));
  const rotation = event.rotationRate;
  const rotationAvailable = Boolean(rotation) && [rotation.alpha, rotation.beta, rotation.gamma].some(value => Number.isFinite(Number(value)));
  return phonePlacement === "hand" ? accelerationAvailable || rotationAvailable : accelerationAvailable;
}

function onDeviceMotion(event) {
  if (!active || !hasMotionVector(event)) return;
  let firstMotionSignal = false;
  const timestampMs = performance.now();
  let phone;
  let armSampleAccepted = false;
  if (phonePlacement === "hand") {
    const cadenceReference = fusion.snapshot(timestampMs);
    const previousArmSamples = armAnalyzer.totalSamples;
    armSnapshot = armAnalyzer.update({
      timestampMs,
      acceleration: event.acceleration,
      accelerationIncludingGravity: event.accelerationIncludingGravity,
      rotationRate: event.rotationRate,
      cadenceSpm: cadenceReference.cadenceSpm,
      cadenceSource: cadenceReference.cadenceSource,
      movementStateOverride: cadenceReference.cadenceSource === "garmin" ? cadenceReference.movementState : null,
      recordingAllowed: !snapshot.plannedBreakActive
    });
    armSampleAccepted = armAnalyzer.totalSamples > previousArmSamples;
    phone = {
      cadenceSpm: null,
      movementState: armSnapshot.movementState,
      motionIntensity: armSnapshot.motionIntensity,
      stepDetected: armSnapshot.halfSwingDetected
    };
  } else {
    phone = detector.update({
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
  }
  const usableMotion = phonePlacement === "hand"
    ? armSampleAccepted
    : true;
  if (usableMotion) {
    lastMotionAtMs = timestampMs;
    if (interruptionActive?.reason === "motion-gap") endInterruption();
    if (fieldSession && !motionSignalConfirmed) {
      motionSignalConfirmed = true;
      firstMotionSignal = true;
      clearMotionTimeout();
      setConnection("phone-connection", "MOTION CONFIRMED");
      if (interruptionActive) endInterruption();
    }
  }
  processSignal(fusion.updatePhone({ timestampMs, ...phone }));
  persistActiveSession();
  if (firstMotionSignal) maybeConfirmPreflight();
}

function failPreflight(message, source = "motion") {
  closeFinishConfirmation({ restoreFocus: false });
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
  if (pendingCompletedRun) {
    reply("Your completed run still needs to be saved. Tap Retry Save before starting another run.");
    return;
  }
  try {
    await requestMotionPermission();
    applyRunConfiguration();
    detector = new HipMotionCadenceDetector();
    fusion = new RunSignalFusion();
    coach = new RunRhythmCoach();
    formAnalyzer = new HipFormAnalyzer();
    armAnalyzer = new ArmSwingAnalyzer();
    techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
    techniqueSnapshot = techniqueEngine.snapshot(0);
    latestRetrospectiveComparison = null;
    lastTechniqueExperimentCount = 0;
    techniqueDemoScale = 1;
    techniqueDemoOffsetMs = 0;
    lastTechniqueRecordedElapsedMs = -Infinity;
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
    showingCompletedReport = false;
    completedSaveState = "idle";
    placementSwitchCount = 0;
    setPreflightItem("preflight-motion", "MOTION CHECK", "waiting");
    setPreflightItem("preflight-screen", "SCREEN CHECK", "waiting");
    setPreflightItem("preflight-pocket", phonePlacement === "hand" ? "RUN LOCK ARMING" : "POCKET ARMING", "waiting");
    updateBatteryDisplay();
    setConnection("phone-connection", "WAITING FOR MOTION", "warning");
    setConnection("screen-connection", "CHECKING SCREEN", "warning");
    window.addEventListener("devicemotion", onDeviceMotion);
    snapshot = {
      ...coach.start(sessionStartedAtMs),
      status: "PREFLIGHT",
      message: phonePlacement === "hand"
        ? "Checking hand motion and screen-awake protection."
        : "Checking phone motion and screen-awake protection."
    };
    formSnapshot = formAnalyzer.start(sessionStartedAtMs);
    armSnapshot = armAnalyzer.start(sessionStartedAtMs);
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
    armAnalyzer = new ArmSwingAnalyzer();
    const now = performance.now();
    snapshot = coach.restoreState(restored.coachState, now);
    phonePlacement = restored.phonePlacement === "hand" ? "hand" : "hip";
    formSnapshot = restored.formState ? formAnalyzer.restoreState(restored.formState, now) : formAnalyzer.start(now);
    armSnapshot = restored.armState ? armAnalyzer.restoreState(restored.armState, now) : armAnalyzer.start(now);
    pocketSide = restored.pocketSide === "left" ? "left" : "right";
    active = true;
    fieldSession = true;
    sessionStartedAtEpochMs = restored.startedAtEpochMs;
    sessionStartedAtMs = now - Math.max(0, Date.now() - restored.startedAtEpochMs);
    comparisonWindowMs = TECHNIQUE_WINDOW_OPTIONS_MS.includes(restored.comparisonWindowMs)
      ? restored.comparisonWindowMs
      : comparisonWindowMs;
    currentTerrain = RUN_TERRAINS.includes(restored.terrain) ? restored.terrain : currentTerrain;
    const restoredTechniqueElapsedMs = techniqueElapsedAt(now);
    try {
      techniqueEngine = restored.techniqueState
        ? TechniqueLapEngine.restore(restored.techniqueState, { elapsedMs: restoredTechniqueElapsedMs })
        : new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
    } catch (_) {
      techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
    }
    techniqueSnapshot = techniqueEngine.snapshot(restoredTechniqueElapsedMs);
    currentTerrain = techniqueSnapshot.currentTerrain;
    comparisonWindowMs = techniqueSnapshot.windowMs;
    lastTechniqueExperimentCount = techniqueSnapshot.experiments.length;
    latestRetrospectiveComparison = null;
    techniqueDemoScale = 1;
    techniqueDemoOffsetMs = 0;
    lastTechniqueRecordedElapsedMs = techniqueSnapshot.elapsedMs - 1_000;
    interruptions = [...restored.interruptions];
    interruptionActive = interruptions.at(-1)?.endedAtEpochMs == null ? interruptions.at(-1) : null;
    motionSignalConfirmed = false;
    preflightConfirmed = false;
    preflightAnnounced = true;
    lastMotionAtMs = null;
    savedSession = null;
    showingCompletedReport = false;
    placementSwitchCount = Number.isFinite(Number(restored.placementSwitchCount))
      ? Math.max(0, Math.floor(Number(restored.placementSwitchCount)))
      : 0;
    if (!interruptionActive) {
      interruptions.push(createInterruption({ reason: "app-restarted", startedAtEpochMs: restored.savedAtEpochMs }));
      interruptionActive = interruptions.at(-1);
    }
    setConnection("phone-connection", "WAITING FOR MOTION", "warning");
    setConnection("screen-connection", "RECOVERING SCREEN", "warning");
    setPreflightItem("preflight-motion", "MOTION CHECK", "waiting");
    setPreflightItem("preflight-screen", "SCREEN CHECK", "waiting");
    setPreflightItem("preflight-pocket", phonePlacement === "hand" ? "RUN LOCK ARMING" : "POCKET ARMING", "waiting");
    window.addEventListener("devicemotion", onDeviceMotion);
    render(true);
    startResilienceMonitor();
    await requestWakeLock();
    motionSignalTimeout = setTimeout(() => {
      if (active && !motionSignalConfirmed) setConnection("phone-connection", "NO MOTION YET", "warning");
    }, 6_000);
    speak(`Saved run restored. Move the phone to confirm motion, then ${phonePlacement === "hand" ? "run lock" : "pocket lock"} will reactivate.`);
    persistActiveSession(true);
  } catch (error) {
    snapshot = { ...snapshot, status: "SENSOR ERROR", message: error?.message || "The saved run could not resume.", events: [] };
    render(true);
  }
}

function closeFinishConfirmation({ restoreFocus = true } = {}) {
  if (els["finish-dialog"].open) els["finish-dialog"].close();
  doc.body.classList.remove("finish-confirming");
  const returnFocus = finishReturnFocus;
  finishReturnFocus = null;
  if (restoreFocus && active && returnFocus?.isConnected) {
    requestAnimationFrame(() => returnFocus.focus());
  }
}

function requestFinishConfirmation() {
  if (!active || els["finish-dialog"].open) return;
  finishReturnFocus = doc.activeElement;
  const elapsedMs = sessionStartedAtMs === null
    ? lastSessionElapsedMs
    : Math.max(0, snapshot.timestampMs - sessionStartedAtMs);
  els["finish-dialog-description"].textContent = `${formatMinutes(elapsedMs)} recorded. The coach will stop measuring and open your review.`;
  doc.body.classList.add("finish-confirming");
  els["finish-dialog"].showModal();
  els["finish-cancel"].focus();
}

function cancelFinishConfirmation() {
  closeFinishConfirmation();
}

function confirmFinishSession() {
  closeFinishConfirmation({ restoreFocus: false });
  finishSession();
}

function storeCompletedRun(payload) {
  completedFormReport = payload;
  showingCompletedReport = true;
  pendingCompletedRun = payload;
  const saved = writeStoredJson(completedRunStorageKey, payload);
  completedSaveState = saved ? "saved" : "failed";
  if (saved) pendingCompletedRun = null;
  return saved;
}

function retryCompletedRunSave() {
  if (!pendingCompletedRun) return;
  const saved = storeCompletedRun(pendingCompletedRun);
  if (saved) {
    clearPersistedSession();
    speak("Run saved on this phone.");
  }
  render(true);
}

function finishSession() {
  if (!active) return;
  closeFinishConfirmation({ restoreFocus: false });
  setPocketLock(false);
  pendingFinishUntil = -Infinity;
  clearMotionTimeout();
  lastSessionElapsedMs = sessionStartedAtMs === null ? 0 : Math.max(0, snapshot.timestampMs - sessionStartedAtMs);
  advanceTechniqueClock(performance.now(), { announce: false });
  if (techniqueSnapshot.active) {
    techniqueEngine.finishActive(techniqueSnapshot.elapsedMs, "run-ended");
    techniqueSnapshot = techniqueEngine.snapshot(techniqueSnapshot.elapsedMs);
    detectTechniqueExperimentChange({ announce: false });
  }
  const retrospective = techniqueEngine.compareLastToPrevious({
    elapsedMs: techniqueSnapshot.elapsedMs,
    windowMs: techniqueSnapshot.windowMs
  });
  latestRetrospectiveComparison = retrospective.available ? retrospective : null;
  if (interruptionActive) endInterruption();
  const interruptionData = interruptionSummary(interruptions);
  if (phonePlacement === "hand") armSnapshot = armAnalyzer.snapshot(performance.now(), { force: true });
  else formSnapshot = formAnalyzer.snapshot(performance.now(), { force: true });
  const armFinishNote = phonePlacement !== "hand"
    ? ""
    : !armSnapshot.baselineReady
      ? ` Arm swing baseline reached ${armSnapshot.baselineProgress || 0} percent, so no range comparison was made.`
      : Number.isFinite(armSnapshot.armCycleRpm) && Number.isFinite(armSnapshot.regularityPercent)
        ? ` Arm swing finished at ${Math.round(armSnapshot.armCycleRpm)} cycles per minute with ${armSnapshot.regularityPercent} percent regularity.${Number.isFinite(armSnapshot.rangeChangePercent) ? ` Range was ${Math.abs(armSnapshot.rangeChangePercent)} percent ${armSnapshot.rangeChangePercent >= 0 ? "larger" : "smaller"} than the opening pattern.` : ""}`
        : " Arm swing data was insufficient for a final rhythm score.";
  const interruptionNote = interruptionData.count
    ? ` Recording was interrupted ${interruptionData.count} ${interruptionData.count === 1 ? "time" : "times"} for about ${formatMinutes(interruptionData.totalMs)}.`
    : " Recording remained continuous.";
  const rhythmSummary = Number.isFinite(snapshot.baselineCadenceSpm)
    ? `${snapshot.stablePercent} percent of measured running cadence was inside your rhythm band. Longest steady block ${formatMinutes(snapshot.longestStableBlockMs)}.`
    : phonePlacement === "hand"
      ? "Step-cadence efficiency was not scored because no completed Garmin cadence baseline was available."
      : "The step-cadence baseline was not completed, so rhythm-band time was not scored.";
  const switchNote = placementSwitchCount > 0
    ? ` Motion measurements report the final ${phonePlacement === "hand" ? "hand-swing" : "hip-pocket"} segment after ${placementSwitchCount} position ${placementSwitchCount === 1 ? "switch" : "switches"}; earlier position segments are excluded from this report.`
    : "";
  const summary = `Field test complete. ${rhythmSummary} ${snapshot.unplannedWalks} unplanned ${snapshot.unplannedWalks === 1 ? "walk" : "walks"}.${interruptionNote}${armFinishNote}${switchNote}`;
  snapshot = { ...snapshot, status: "REVIEW", message: summary, events: [] };
  let completedSaved = !fieldSession;
  if (fieldSession) {
    const completedPayload = makeCompletedRun({
      completedAtEpochMs: Date.now(),
      elapsedMs: lastSessionElapsedMs,
      runSnapshot: snapshot,
      motionSnapshot: phonePlacement === "hand" ? armSnapshot : formSnapshot,
      phonePlacement,
      pocketSide,
      placementSwitchCount,
      interruptions,
      techniqueComparisons: techniqueEngine.getCompletedComparisons(),
      terrainSegments: techniqueEngine.getTerrainSegments(),
      comparisonWindowMs: techniqueSnapshot.windowMs,
      retrospectiveComparison: latestRetrospectiveComparison
    });
    completedSaved = storeCompletedRun(completedPayload);
  } else completedSaveState = "demo";
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
  setConnection("phone-connection", "PHONE READY");
  speak(summary);
  render(true);
}

function startDemo() {
  if (pendingCompletedRun) {
    reply("Your completed run still needs to be saved. Tap Retry Save before starting the demo.");
    return;
  }
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
  armAnalyzer = new ArmSwingAnalyzer();
  demoPreviousComparisonWindowMs = comparisonWindowMs;
  comparisonWindowMs = 60_000;
  techniqueEngine = new TechniqueLapEngine({ windowMs: comparisonWindowMs, initialTerrain: currentTerrain });
  techniqueSnapshot = techniqueEngine.snapshot(0);
  latestRetrospectiveComparison = null;
  lastTechniqueExperimentCount = 0;
  techniqueDemoScale = 6;
  techniqueDemoOffsetMs = 60_000;
  for (let elapsedMs = 0; elapsedMs < techniqueDemoOffsetMs; elapsedMs += 1_000) {
    techniqueEngine.recordFrame({
      elapsedMs,
      movementState: "running",
      eligible: true,
      cadenceSpm: 170,
      rhythmStable: true,
      metrics: { hipVerticalIndex: 0.82, hipHorizontalIndex: 0.42, hipRotationIndex: 18, hipImpactVariationIndex: 0.11 },
      placement: phonePlacement,
      side: pocketSide,
      cadenceSource: "phone",
      sensorSource: "demo"
    });
  }
  techniqueSnapshot = techniqueEngine.snapshot(techniqueDemoOffsetMs);
  lastTechniqueRecordedElapsedMs = techniqueDemoOffsetMs - 1_000;
  active = true;
  fieldSession = false;
  motionSignalConfirmed = false;
  preflightConfirmed = false;
  pendingCompletedRun = null;
  completedSaveState = "demo";
  demoStartedAt = performance.now();
  sessionStartedAtMs = demoStartedAt;
  lastSessionElapsedMs = 0;
  placementSwitchCount = 0;
  handleSnapshot(coach.start(demoStartedAt));
  formSnapshot = formAnalyzer.start(demoStartedAt);
  armSnapshot = armAnalyzer.start(demoStartedAt);
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
  await executeRunIntent(message);
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
  els["placement-switch"].disabled = !active || pocketLocked;
  if (pocketLocked) lockReturnFocus = els["pocket-lock"];
  els["pocket-lock-screen"].hidden = !pocketLocked;
  doc.querySelector(".run-shell").inert = pocketLocked;
  doc.body.classList.toggle("pocket-locked", pocketLocked);
  cancelPocketUnlock();
  if (pocketLocked) {
    await requestWakeLock();
    try { await doc.documentElement.requestFullscreen?.({ navigationUI: "hide" }); } catch (_) {}
    setPreflightItem("preflight-pocket", phonePlacement === "hand" ? "RUN LOCKED" : "POCKET LOCKED", "ready");
    els["pocket-unlock"].focus({ preventScroll: true });
    if (announce) reply(`${phonePlacement === "hand" ? "Run lock" : "Pocket lock"} on. Press and hold the unlock button for two seconds to unlock.`);
  } else if (doc.fullscreenElement) {
    try { await doc.exitFullscreen(); } catch (_) {}
  }
  if (!pocketLocked && lockReturnFocus) {
    const focusTarget = lockReturnFocus;
    lockReturnFocus = null;
    requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
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
window.runCoachTechniqueAction = payload => executeRunIntent(normaliseRunControlAction(payload));
voiceController = BrowserVoiceController.fromWindow(window, {
  onTranscript: handleVoiceTranscript,
  onState: handleVoiceState
});
els["start-session"].addEventListener("click", handlePrimaryStartAction);
els["resume-session"].addEventListener("click", resumeSavedSession);
els["stop-session"].addEventListener("click", requestFinishConfirmation);
els["finish-cancel"].addEventListener("click", cancelFinishConfirmation);
els["finish-confirm"].addEventListener("click", confirmFinishSession);
els["retry-save"].addEventListener("click", retryCompletedRunSave);
els["finish-dialog"].addEventListener("cancel", event => {
  event.preventDefault();
  cancelFinishConfirmation();
});
els["finish-dialog"].addEventListener("click", event => {
  if (event.target === els["finish-dialog"]) cancelFinishConfirmation();
});
els["demo-session"].addEventListener("click", startDemo);
els["mark-change"].addEventListener("click", () => executeRunIntent({ command: VOICE_INTENTS.MARK_CHANGE }));
els["planned-walk"].addEventListener("click", () => handleSnapshot(coach.markPlannedBreak(performance.now())));
els["resume-run"].addEventListener("click", resumeRunning);
els["speak-status"].addEventListener("click", () => reply(statusSentence()));
els["silence-coach"].addEventListener("click", toggleVoicePrompts);
els["start-vibration"].addEventListener("click", toggleStartVibration);
els["placement-hip"].addEventListener("click", () => setPhonePlacement("hip"));
els["placement-hand"].addEventListener("click", () => setPhonePlacement("hand"));
els["placement-switch"].addEventListener("click", () => setPhonePlacement(phonePlacement === "hand" ? "hip" : "hand"));
els["view-last-run"].addEventListener("click", viewCompletedReport);
els["pocket-side-left"].addEventListener("click", () => setPocketSide("left"));
els["pocket-side-right"].addEventListener("click", () => setPocketSide("right"));
els["voice-toggle"].addEventListener("click", toggleVoiceControls);
els["voice-prompts-toggle"].addEventListener("click", toggleVoicePrompts);
els["terrain-chip"].addEventListener("click", openTerrainDialog);
els["terrain-dialog-close"].addEventListener("click", () => els["terrain-dialog"].close());
els["terrain-dialog"].addEventListener("cancel", event => {
  event.preventDefault();
  els["terrain-dialog"].close();
});
els["terrain-dialog"].addEventListener("click", event => {
  if (event.target === els["terrain-dialog"]) els["terrain-dialog"].close();
});
for (const button of doc.querySelectorAll("[data-terrain-option]")) {
  button.addEventListener("click", () => setTerrainContext(button.dataset.terrainOption, { announce: active, source: "touch" }));
}
for (const button of doc.querySelectorAll("[data-window-minutes]")) {
  button.addEventListener("click", () => setTechniqueWindow(Number(button.dataset.windowMinutes) * 60_000));
}
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
initialiseBatteryCheck();
initialiseStorageCheck();
if (savedSession) {
  snapshot = { ...snapshot, status: "SAVED RUN", message: "A previous run can be resumed without losing its recorded summary.", events: [] };
} else restoreCompletedReport();
render(true);
