const normalisePlacement = placement => placement === "hand" ? "hand" : "hip";
const normaliseSide = side => side === "left" ? "left" : "right";

export function runConfigurationLocked(state = {}) {
  const { active = false, hasSavedSession = false } = state;
  return Boolean(active || hasSavedSession);
}

export function selectRunConfiguration({
  currentPlacement = "hip",
  currentSide = "right",
  reviewingCompletedReport = false,
  reportPlacement = "hip",
  reportSide = "right",
  selectedPlacement,
  selectedSide
} = {}) {
  const basePlacement = reviewingCompletedReport ? reportPlacement : currentPlacement;
  const baseSide = reviewingCompletedReport ? reportSide : currentSide;
  return {
    placement: normalisePlacement(selectedPlacement ?? basePlacement),
    side: normaliseSide(selectedSide ?? baseSide)
  };
}
