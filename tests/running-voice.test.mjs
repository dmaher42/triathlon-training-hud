import assert from "node:assert/strict";
import test from "node:test";
import { BrowserVoiceController, VOICE_INTENTS, parseVoiceCommand } from "../src/running/voice-commands.js";

const commandCases = [
  ["start run", VOICE_INTENTS.START],
  ["Hey coach begin the session", VOICE_INTENTS.START],
  ["coach status", VOICE_INTENTS.STATUS],
  ["arm status", VOICE_INTENTS.STATUS],
  ["how am I doing", VOICE_INTENTS.STATUS],
  ["mark a planned walk", VOICE_INTENTS.PLANNED_WALK],
  ["back to running", VOICE_INTENTS.RESUME],
  ["switch to hip pocket", VOICE_INTENTS.SWITCH_HIP],
  ["hand swing mode", VOICE_INTENTS.SWITCH_HAND],
  ["mark change", VOICE_INTENTS.MARK_CHANGE],
  ["start technique comparison", VOICE_INTENTS.MARK_CHANGE],
  ["technique status", VOICE_INTENTS.TECHNIQUE_STATUS],
  ["cancel comparison", VOICE_INTENTS.CANCEL_COMPARISON],
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

const comparisonCases = [
  ["compare last one", VOICE_INTENTS.COMPARE_RECENT, 1],
  ["compare the last 3 minutes", VOICE_INTENTS.COMPARE_RECENT, 3],
  ["compare last five", VOICE_INTENTS.COMPARE_RECENT, 5],
  ["compare 10 minutes", VOICE_INTENTS.COMPARE_RECENT, 10],
  ["show previous 1 minute", VOICE_INTENTS.SHOW_PREVIOUS, 1],
  ["review the previous three", VOICE_INTENTS.SHOW_PREVIOUS, 3],
  ["show me the previous five minutes", VOICE_INTENTS.SHOW_PREVIOUS, 5],
  ["previous ten", VOICE_INTENTS.SHOW_PREVIOUS, 10]
];

for (const [phrase, intent, windowMinutes] of comparisonCases) {
  test(`normalises the comparison window: ${phrase}`, () => {
    assert.deepEqual(parseVoiceCommand(phrase), {
      intent,
      transcript: phrase,
      windowMinutes
    });
  });
}

const terrainCases = [
  ["set terrain to unlabelled", "unlabelled"],
  ["clear terrain", "unlabelled"],
  ["terrain flat", "flat"],
  ["change terrain to up hill", "uphill"],
  ["downhill terrain", "downhill"],
  ["terrain rolling hills", "rolling"],
  ["terrain uneven", "trail"],
  ["trail terrain", "trail"],
  ["switch the terrain to treadmill", "treadmill"]
];

for (const [phrase, terrain] of terrainCases) {
  test(`normalises the terrain command: ${phrase}`, () => {
    assert.deepEqual(parseVoiceCommand(phrase), {
      intent: VOICE_INTENTS.SET_TERRAIN,
      transcript: phrase,
      terrain
    });
  });
}

test("does not accept unsupported comparison windows or terrain labels", () => {
  assert.equal(parseVoiceCommand("compare last two").intent, VOICE_INTENTS.UNKNOWN);
  assert.equal(parseVoiceCommand("terrain mountain").intent, VOICE_INTENTS.UNKNOWN);
});

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
