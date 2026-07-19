import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../running/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/running/running.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/running/app.js", import.meta.url), "utf8");

test("every running app binding has one permanent DOM element", () => {
  const registry = app.match(/Object\.fromEntries\(\[([\s\S]*?)\]\.map\(id/);
  assert.ok(registry, "app element registry should remain readable");

  const ids = [...registry[1].matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]);
  assert.ok(ids.length > 80, "the complete running UI registry should be covered");

  for (const id of ids) {
    const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
    assert.equal(matches.length, 1, `#${id} should exist exactly once`);
  }
});

test("ready and active layouts retain the approved phone dashboard structure", () => {
  assert.match(html, /class="settings-menu"/);
  assert.match(html, /id="phone-connection"[\s\S]*id="preflight-motion"[\s\S]*id="voice-dock"/);
  assert.match(html, /class="status-orb"/);
  assert.match(html, /<span>CADENCE<\/span>[\s\S]*<span>RHYTHM STABILITY<\/span>[\s\S]*<span>RUN TIME<\/span>[\s\S]*<span>UNPLANNED WALKS<\/span>/);
  assert.match(html, /<span>PHONE PLACEMENT<\/span>[\s\S]*id="placement-hip"[\s\S]*id="placement-hand"/);
});

test("running dashboard uses a dimensional phone canvas and state compositions", () => {
  assert.match(css, /width:\s*min\(100%,\s*440px\)/);
  assert.match(css, /body\[data-session="ready"\][\s\S]*\.metric-grid/);
  assert.match(css, /body\[data-session="active"\][\s\S]*\.metric-grid/);
  assert.match(css, /body\[data-session="active"\][\s\S]*\.run-controls/);
  assert.match(css, /box-shadow:[\s\S]*inset/);
  assert.match(css, /linear-gradient\(145deg/);
});

test("saved motion reports have one clear action that returns cleanly to Ready", () => {
  assert.match(html, /id="start-session"[\s\S]*START RUN[\s\S]*id="view-last-run"[\s\S]*VIEW LAST RUN/);
  assert.match(app, /classList\.toggle\("is-report-review", isReview\)/);
  assert.match(app, /viewLastRunAvailable = reportAvailable && !reviewScreen/);
  assert.match(app, /if \(leavingReview\) \{[\s\S]*completedSaveState = "idle";[\s\S]*resetReadySession\(\);[\s\S]*\}/);
  assert.match(app, /view-last-run"\]\.hidden = !viewLastRunAvailable/);
  assert.match(app, /function viewCompletedReport\(\) \{[\s\S]*restoreCompletedReport\(\);[\s\S]*render\(true\);/);
  assert.match(app, /view-last-run"\]\.addEventListener\("click", viewCompletedReport\)/);
  assert.match(app, /start-session"\]\.textContent = reviewingRun \? "START ANOTHER RUN" : "START RUN"/);
  assert.match(app, /function handlePrimaryStartAction\(\) \{[\s\S]*snapshot\.status === "REVIEW"[\s\S]*applyRunConfiguration\(\);[\s\S]*render\(true\);[\s\S]*startSession\(\);/);
  assert.match(app, /start-session"\]\.addEventListener\("click", handlePrimaryStartAction\)/);
  assert.match(app, /demo-session"\]\.hidden = [^;]*\|\| reviewingRun/);
  assert.doesNotMatch(html, /id="form-report-toggle"|>NEW RUN</);
  assert.doesNotMatch(app, /has-report-toggle|toggleCompletedReport/);
  assert.match(css, /\.form-lab\.is-report-review \.form-measures/);
  assert.match(css, /\.view-report-button \{[\s\S]*width:\s*100%[\s\S]*min-height:\s*56px/);
});

test("saved full-run reviews restore their metrics, duration and interruptions", () => {
  assert.match(app, /parseCompletedRun\(readStoredText\(completedRunStorageKey\)\)/);
  assert.match(app, /runSnapshot: snapshot[\s\S]*motionSnapshot:[\s\S]*interruptions/);
  assert.match(app, /snapshot = \{ \.\.\.completedFormReport\.runSnapshot, status: "REVIEW", events: \[\] \}/);
  assert.match(app, /lastSessionElapsedMs = completedFormReport\.elapsedMs/);
  assert.match(app, /interruptions = completedFormReport\.interruptions/);
  assert.match(app, /else restoreCompletedReport\(\);[\s\S]*render\(true\)/);
});

test("the compact active voice control remains a full mobile touch target", () => {
  assert.match(css, /body\[data-session="active"\][\s\S]*\.voice-dock[\s\S]*min-height:\s*44px/);
  assert.match(css, /body\[data-session="active"\] \.voice-toggle \{ min-height:\s*44px/);
});

test("Technique Lap keeps four primary in-run actions and moves prompt settings out of the dashboard", () => {
  const runControls = html.match(/<section class="run-controls"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(runControls, /id="mark-change"[\s\S]*id="planned-walk"[\s\S]*id="resume-run"[\s\S]*id="speak-status"[\s\S]*id="pocket-lock"/);
  assert.doesNotMatch(runControls, /id="silence-coach"/);
  assert.match(html, /class="settings-toggle"[^>]*id="silence-coach"/);
  assert.match(css, /body\[data-session="active"\] \.run-controls:not\(\[hidden\]\)[\s\S]*position:\s*sticky/);
  assert.match(app, /mark-change"\]\.addEventListener\("click"[\s\S]*VOICE_INTENTS\.MARK_CHANGE/);
});

test("Run Lock keeps the live dashboard visible behind its touch shield", () => {
  assert.match(html, /id="pocket-lock-screen"[^>]*live dashboard remains visible/);
  assert.match(app, /querySelector\("\.run-shell"\)\.inert = pocketLocked/);
  assert.match(app, /pocket-lock"\]\.addEventListener\("click", \(\) => setPocketLock\(true\)\)/);
  assert.equal((app.match(/setPocketLock\(true/g) || []).length, 1, "Run Lock should activate only from its button");
  assert.doesNotMatch(app, /(?:RUN|POCKET)(?: LOCK)? ARMING/);
  assert.match(app, /phonePlacement === "hand" \? "RUN LOCK READY" : "POCKET LOCK READY"/);
  assert.match(css, /\.pocket-lock-screen \{[\s\S]*justify-content:\s*flex-end[\s\S]*background:\s*linear-gradient\([\s\S]*transparent/);
  assert.doesNotMatch(css, /\.pocket-lock-screen\s*\{[^}]*background:\s*#000/);
  assert.doesNotMatch(html, /pocket-lock-(?:status|time|cadence|metric-label|readings|health|technique)/);
  assert.doesNotMatch(app, /pocket-lock-(?:status|time|cadence|metric-label|health|technique)|storageHealthy/);
  assert.match(app, /active; live dashboard remains visible/);
  assert.match(css, /#pocket-unlock \{[^}]*min-height:\s*58px/);
});

test("terrain, fixed comparison windows and completed reports use the canonical running flow", () => {
  assert.match(html, /data-terrain-option="unlabelled"[\s\S]*data-terrain-option="treadmill"/);
  assert.match(html, /data-window-minutes="1"[\s\S]*data-window-minutes="3"[\s\S]*data-window-minutes="5"[\s\S]*data-window-minutes="10"/);
  assert.match(html, /id="terrain-chip"[\s\S]*id="technique-panel"[\s\S]*id="technique-report"/);
  assert.match(app, /new TechniqueLapEngine\(\{ windowMs: comparisonWindowMs, initialTerrain: currentTerrain \}\)/);
  assert.match(app, /techniqueState: techniqueEngine\.exportState\(\)/);
  assert.match(app, /techniqueComparisons: techniqueEngine\.getCompletedComparisons\(\)[\s\S]*terrainSegments: techniqueEngine\.getTerrainSegments\(\)/);
  assert.match(app, /retrospectiveComparison: latestRetrospectiveComparison/);
  assert.match(app, /TechniqueLapEngine\.restore\(restored\.techniqueState/);
});

test("active runs expose one large contextual placement switch", () => {
  assert.match(html, /id="placement-switch"[\s\S]*SWITCH TO HAND/);
  assert.match(html, /id="placement-switch-help"[\s\S]*new measurement segment/);
  assert.match(css, /#placement-switch[\s\S]*min-width:\s*138px[\s\S]*min-height:\s*44px/);
  assert.match(app, /planActivePlacementSwitch\(/);
  assert.match(app, /fusion\.updatePhone\(\{ timestampMs: now, cadenceSpm: null/);
  assert.match(app, /formState: formAnalyzer\.exportState\(\)[\s\S]*armState: armAnalyzer\.exportState\(\)/);
});

test("touch finishing requires an explicit confirmation", () => {
  assert.match(html, /<dialog[^>]*id="finish-dialog"[^>]*aria-labelledby="finish-dialog-title"/);
  assert.match(html, /id="finish-cancel"[\s\S]*KEEP RUNNING/);
  assert.match(html, /id="finish-confirm"[\s\S]*FINISH RUN/);
  assert.match(app, /els\["stop-session"\]\.addEventListener\("click", requestFinishConfirmation\)/);
  assert.match(app, /els\["finish-cancel"\]\.addEventListener\("click", cancelFinishConfirmation\)/);
  assert.match(app, /els\["finish-confirm"\]\.addEventListener\("click", confirmFinishSession\)/);
  assert.doesNotMatch(app, /els\["stop-session"\]\.addEventListener\("click", finishSession\)/);
  assert.match(css, /\.finish-dialog::backdrop/);
  assert.match(css, /\.finish-dialog-actions button[\s\S]*min-height:\s*58px/);
});

test("failed completed-run saves remain visible, retryable and protected", () => {
  assert.match(html, /id="save-result"[\s\S]*id="save-result-title"[\s\S]*id="save-result-message"[\s\S]*id="retry-save"/);
  assert.match(app, /pendingCompletedRun = payload[\s\S]*writeStoredJson\(completedRunStorageKey, payload\)[\s\S]*completedSaveState = saved \? "saved" : "failed"/);
  assert.match(app, /completedSaveState === "failed"[\s\S]*"SAVE FAILED"[\s\S]*"RUN SAVED"/);
  assert.match(app, /start-session"\]\.hidden = active \|\| Boolean\(savedSession\) \|\| Boolean\(pendingCompletedRun\)/);
  assert.match(app, /reportAvailable = !active && !savedSession && !pendingCompletedRun/);
  assert.match(app, /if \(pendingCompletedRun\)[\s\S]*Tap Retry Save before starting another run/);
  assert.match(app, /els\["retry-save"\]\.addEventListener\("click", retryCompletedRunSave\)/);
  assert.match(css, /\.save-result\[data-state="failed"\]/);
  assert.match(css, /#retry-save[\s\S]*min-height:\s*44px/);
});

test("Technique persistence flushes closed mechanics before saving its aligned clock", () => {
  assert.match(app, /flushClosedTechniqueFrame\(now\);[\s\S]*techniqueSnapshot = techniqueEngine\.tick\(techniqueElapsedAt\(now\)\);[\s\S]*techniqueState: techniqueEngine\.exportState\(\)/);
  assert.match(app, /techniqueEngine\.recordClosedFrame\(/);
  assert.match(app, /resumeTechniqueElapsed\(\{/);
  assert.match(app, /function cancelTechniqueComparison[\s\S]*advanceTechniqueClock\(now, \{ announce: false \}\);[\s\S]*techniqueEngine\.cancelActive\(techniqueElapsedAt\(now\), reason\)/);
});
