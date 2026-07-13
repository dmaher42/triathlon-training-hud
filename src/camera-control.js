export const CAMERA_MANUAL_HOLD_MS = 8000;

export function decideCameraTimerAction({
  enabled,
  stableState,
  rideState,
  intervalComplete,
  rideTargetReached,
  manualHoldActive
}) {
  if (!enabled || manualHoldActive || intervalComplete || rideTargetReached) return null;
  if (stableState === "upright" && rideState === "aero") return "pause";
  if (stableState === "aero" && rideState === "paused") return "resume";
  return null;
}

export function shouldWaitForAeroAfterBreak({ enabled, stableState }) {
  return enabled && stableState !== "aero";
}
