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

test("saved motion reports remain visible and can return cleanly to Ready", () => {
  assert.match(app, /classList\.toggle\("is-report-review", isReview\)/);
  assert.match(app, /classList\.toggle\("has-report-toggle", reportAvailable\)/);
  assert.match(app, /if \(reviewingCompletedReport\) resetReadySession\(\)/);
  assert.match(css, /\.form-lab\.is-report-review \.form-measures/);
  assert.match(css, /\.form-lab\.has-report-toggle:not\(\.is-report-review\) > header/);
});

test("the compact active voice control remains a full mobile touch target", () => {
  assert.match(css, /body\[data-session="active"\][\s\S]*\.voice-dock[\s\S]*min-height:\s*44px/);
  assert.match(css, /body\[data-session="active"\] \.voice-toggle \{ min-height:\s*44px/);
});

test("active runs expose one large contextual placement switch", () => {
  assert.match(html, /id="placement-switch"[\s\S]*SWITCH TO HAND/);
  assert.match(html, /id="placement-switch-help"[\s\S]*new measurement segment/);
  assert.match(css, /#placement-switch[\s\S]*min-width:\s*138px[\s\S]*min-height:\s*44px/);
  assert.match(app, /planActivePlacementSwitch\(/);
  assert.match(app, /fusion\.updatePhone\(\{ timestampMs: now, cadenceSpm: null/);
  assert.match(app, /formState: formAnalyzer\.exportState\(\)[\s\S]*armState: armAnalyzer\.exportState\(\)/);
});
