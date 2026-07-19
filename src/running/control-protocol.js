import { VOICE_INTENTS } from "./voice-commands.js";

export const RUN_CONTROL_COMMANDS = Object.freeze([
  VOICE_INTENTS.START,
  VOICE_INTENTS.STATUS,
  VOICE_INTENTS.PLANNED_WALK,
  VOICE_INTENTS.RESUME,
  VOICE_INTENTS.SWITCH_HIP,
  VOICE_INTENTS.SWITCH_HAND,
  VOICE_INTENTS.MARK_CHANGE,
  VOICE_INTENTS.TECHNIQUE_STATUS,
  VOICE_INTENTS.CANCEL_COMPARISON,
  VOICE_INTENTS.COMPARE_RECENT,
  VOICE_INTENTS.SHOW_PREVIOUS,
  VOICE_INTENTS.SET_TERRAIN,
  VOICE_INTENTS.QUIET,
  VOICE_INTENTS.PROMPTS_ON,
  VOICE_INTENTS.FINISH_REQUEST,
  VOICE_INTENTS.FINISH_CONFIRM,
  VOICE_INTENTS.FINISH_CANCEL,
  VOICE_INTENTS.HELP
]);

export const RUN_COMPARISON_WINDOWS = Object.freeze([1, 3, 5, 10]);
export const RUN_TERRAINS = Object.freeze([
  "unlabelled",
  "flat",
  "uphill",
  "downhill",
  "rolling",
  "trail",
  "treadmill"
]);

const allowedCommands = new Set(RUN_CONTROL_COMMANDS);
const allowedWindowMinutes = new Set(RUN_COMPARISON_WINDOWS);
const allowedTerrains = new Set(RUN_TERRAINS);
const terrainAliases = Object.freeze({
  unlabeled: "unlabelled",
  uneven: "trail",
  "trail/uneven": "trail",
  "up hill": "uphill",
  "down hill": "downhill",
  "rolling hills": "rolling"
});

export function normaliseRunControlAction(payload) {
  const command = payload?.command || payload?.intent;
  if (!allowedCommands.has(command)) {
    throw new TypeError(`Unsupported run-control command: ${command}`);
  }

  const action = { command };
  if ([VOICE_INTENTS.COMPARE_RECENT, VOICE_INTENTS.SHOW_PREVIOUS].includes(command)) {
    const windowMinutes = Number(payload.windowMinutes);
    if (!allowedWindowMinutes.has(windowMinutes)) {
      throw new TypeError(`Unsupported comparison window: ${payload.windowMinutes}`);
    }
    action.windowMinutes = windowMinutes;
  }
  if (command === VOICE_INTENTS.SET_TERRAIN) {
    const requestedTerrain = String(payload.terrain || "").toLowerCase().trim();
    const terrain = terrainAliases[requestedTerrain] || requestedTerrain;
    if (!allowedTerrains.has(terrain)) {
      throw new TypeError(`Unsupported terrain: ${payload.terrain}`);
    }
    action.terrain = terrain;
  }
  return action;
}

export function normaliseRunControlMessage(payload) {
  if (!payload || payload.type !== "run-control" || Number(payload.version) !== 1) {
    throw new TypeError("Unsupported run-control message.");
  }
  const action = normaliseRunControlAction(payload);
  return {
    type: "run-control",
    version: 1,
    source: payload.source === "garmin" ? "garmin" : "companion",
    ...action,
    requestId: String(payload.requestId || "").slice(0, 64)
  };
}

export function createRunControlAck(message, { accepted, detail = "" } = {}) {
  return {
    type: "run-control-ack",
    version: 1,
    requestId: message.requestId,
    command: message.command,
    accepted: Boolean(accepted),
    detail: String(detail).slice(0, 120)
  };
}
