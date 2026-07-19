import assert from "node:assert/strict";
import test from "node:test";
import {
  planActivePlacementSwitch,
  runConfigurationLocked,
  selectRunConfiguration
} from "../src/running/run-configuration.js";

test("completed-report controls prepare a matching new run", () => {
  assert.equal(runConfigurationLocked({ reviewingCompletedReport: true }), false);
  assert.equal(runConfigurationLocked({ active: true, reviewingCompletedReport: true }), true);
  assert.equal(runConfigurationLocked({ hasSavedSession: true, reviewingCompletedReport: true }), true);

  assert.deepEqual(selectRunConfiguration({
    currentPlacement: "hip",
    currentSide: "left",
    reviewingCompletedReport: true,
    reportPlacement: "hand",
    reportSide: "right",
    selectedSide: "left"
  }), {
    placement: "hand",
    side: "left"
  });

  assert.deepEqual(selectRunConfiguration({
    currentPlacement: "hip",
    currentSide: "left",
    reviewingCompletedReport: true,
    reportPlacement: "hip",
    reportSide: "right",
    selectedPlacement: "hand"
  }), {
    placement: "hand",
    side: "right"
  });

  assert.deepEqual(selectRunConfiguration({
    currentPlacement: "hip",
    currentSide: "left",
    reviewingCompletedReport: true,
    reportPlacement: "hand",
    reportSide: "right"
  }), {
    placement: "hand",
    side: "right"
  });
});

test("ordinary selections preserve the dimension that was not changed", () => {
  assert.deepEqual(selectRunConfiguration({
    currentPlacement: "hand",
    currentSide: "left",
    selectedSide: "right"
  }), {
    placement: "hand",
    side: "right"
  });

  assert.deepEqual(selectRunConfiguration({
    currentPlacement: "hand",
    currentSide: "left",
    selectedPlacement: "hip"
  }), {
    placement: "hip",
    side: "left"
  });
});

test("active placement changes are allowed only after Run Lock is released", () => {
  assert.deepEqual(planActivePlacementSwitch({
    active: true,
    currentPlacement: "hip",
    requestedPlacement: "hand"
  }), {
    changed: true,
    placement: "hand",
    blockedReason: null
  });

  assert.equal(planActivePlacementSwitch({
    active: true,
    pocketLocked: true,
    currentPlacement: "hip",
    requestedPlacement: "hand"
  }).blockedReason, "locked");
  assert.equal(planActivePlacementSwitch({
    active: false,
    currentPlacement: "hip",
    requestedPlacement: "hand"
  }).blockedReason, "inactive");
  assert.equal(planActivePlacementSwitch({
    active: true,
    currentPlacement: "hand",
    requestedPlacement: "hand"
  }).blockedReason, "same-placement");
});
