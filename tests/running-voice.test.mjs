import assert from "node:assert/strict";
import test from "node:test";
import { BrowserVoiceController, VOICE_INTENTS, parseVoiceCommand } from "../src/running/voice-commands.js";

const commandCases = [
  ["start run", VOICE_INTENTS.START],
  ["Hey coach begin the session", VOICE_INTENTS.START],
  ["coach status", VOICE_INTENTS.STATUS],
  ["how am I doing", VOICE_INTENTS.STATUS],
  ["mark a planned walk", VOICE_INTENTS.PLANNED_WALK],
  ["back to running", VOICE_INTENTS.RESUME],
  ["quiet for ten minutes", VOICE_INTENTS.QUIET],
  ["voice prompts off", VOICE_INTENTS.QUIET],
  ["voice prompts on", VOICE_INTENTS.PROMPTS_ON],
  ["finish run", VOICE_INTENTS.FINISH_REQUEST],
  ["voice help", VOICE_INTENTS.HELP],
  ["stop listening", VOICE_INTENTS.VOICE_OFF]
];

for (const [phrase, intent] of commandCases) {
  test(`recognises the voice command: ${phrase}`, () => {
    assert.equal(parseVoiceCommand(phrase).intent, intent);
  });
}

test("requires an explicit confirmation before finishing", () => {
  assert.equal(parseVoiceCommand("confirm finish").intent, VOICE_INTENTS.UNKNOWN);
  assert.equal(parseVoiceCommand("confirm finish", { awaitingFinishConfirmation: true }).intent, VOICE_INTENTS.FINISH_CONFIRM);
  assert.equal(parseVoiceCommand("keep running", { awaitingFinishConfirmation: true }).intent, VOICE_INTENTS.FINISH_CANCEL);
});

test("reports unsupported recognition without attempting to listen", () => {
  const states = [];
  const controller = new BrowserVoiceController({ onState: update => states.push(update.state) });
  assert.equal(controller.enable(), false);
  assert.deepEqual(states, ["unsupported"]);
});

test("starts recognition and forwards final alternatives", () => {
  const transcripts = [];
  class FakeRecognition {
    constructor() { FakeRecognition.instance = this; }
    start() { this.onstart(); }
    abort() { this.onend(); }
  }
  const controller = new BrowserVoiceController({
    Recognition: FakeRecognition,
    onTranscript: alternatives => transcripts.push(alternatives)
  });
  assert.equal(controller.enable(), true);
  assert.equal(controller.listening, true);
  const result = [{ transcript: "coach status" }, { transcript: "run status" }];
  result.isFinal = true;
  FakeRecognition.instance.onresult({ resultIndex: 0, results: [result] });
  assert.deepEqual(transcripts, [["coach status", "run status"]]);
  controller.disable();
});

test("a microphone permission denial disables automatic restart", () => {
  class FakeRecognition {
    constructor() { FakeRecognition.instance = this; }
    start() { this.onstart(); }
    abort() {}
  }
  const states = [];
  const controller = new BrowserVoiceController({
    Recognition: FakeRecognition,
    onState: update => states.push(update.state)
  });
  controller.enable();
  FakeRecognition.instance.onerror({ error: "not-allowed" });
  assert.equal(controller.enabled, false);
  assert.equal(states.at(-1), "denied");
});
