import { VOICE_INTENTS } from "./voice-commands.js";

export const RUN_CONTROL_COMMANDS = Object.freeze([
  VOICE_INTENTS.START,
  VOICE_INTENTS.STATUS,
  VOICE_INTENTS.PLANNED_WALK,
  VOICE_INTENTS.RESUME,
  VOICE_INTENTS.QUIET,
  VOICE_INTENTS.FINISH_REQUEST,
  VOICE_INTENTS.FINISH_CONFIRM,
  VOICE_INTENTS.FINISH_CANCEL,
  VOICE_INTENTS.HELP
]);

const allowedCommands = new Set(RUN_CONTROL_COMMANDS);

export function normaliseRunControlMessage(payload) {
  if (!payload || payload.type !== "run-control" || Number(payload.version) !== 1) {
    throw new TypeError("Unsupported run-control message.");
  }
  if (!allowedCommands.has(payload.command)) {
    throw new TypeError(`Unsupported run-control command: ${payload.command}`);
  }
  return {
    type: "run-control",
    version: 1,
    source: payload.source === "garmin" ? "garmin" : "companion",
    command: payload.command,
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
