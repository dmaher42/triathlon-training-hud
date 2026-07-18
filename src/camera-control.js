export const CAMERA_MANUAL_HOLD_MS = 8000;

export function cameraLearningAnswerForKey(key) {
  if (["Enter", "ArrowLeft", "ArrowUp"].includes(key)) return true;
  if (["ArrowRight", "ArrowDown"].includes(key)) return false;
  return null;
}

export function nextCameraAeroPosition({ enabled, stableState, currentlyAero }) {
  if (!enabled || stableState === "uncertain") return Boolean(currentlyAero);
  if (stableState === "aero") return true;
  if (stableState === "upright") return false;
  return Boolean(currentlyAero);
}

export function decideCameraTimerAction({
  enabled,
  stableState,
  rideState,
  intervalComplete,
  rideTargetReached,
  manualHoldActive
}) {
  if (!enabled || manualHoldActive || rideTargetReached) return null;
  if (stableState === "upright" && rideState === "aero") return "pause";
  if (stableState === "aero" && rideState === "paused") return "resume";
  return null;
}

export function shouldWaitForAeroAfterBreak({ enabled, stableState }) {
  return enabled && stableState !== "aero";
}
