const normalise = value => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const matches = (text, patterns) => patterns.some(pattern => pattern.test(text));

const WINDOW_MINUTES = Object.freeze({
  "1": 1,
  one: 1,
  "3": 3,
  three: 3,
  "5": 5,
  five: 5,
  "10": 10,
  ten: 10
});

const TERRAIN_ALIASES = Object.freeze({
  unlabelled: "unlabelled",
  unlabeled: "unlabelled",
  none: "unlabelled",
  flat: "flat",
  uphill: "uphill",
  "up hill": "uphill",
  downhill: "downhill",
  "down hill": "downhill",
  rolling: "rolling",
  "rolling hills": "rolling",
  trail: "trail",
  uneven: "trail",
  "trail uneven": "trail",
  treadmill: "treadmill"
});

const readWindowMinutes = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return WINDOW_MINUTES[match[1]] || null;
  }
  return null;
};

const readTerrain = text => {
  if (/^(clear|reset|remove)(\s+the)?\s+terrain(\s+label)?$/.test(text)) return "unlabelled";
  const patterns = [
    /^(?:set|change|switch)(?:\s+the)?\s+terrain(?:\s+to)?\s+(.+)$/,
    /^terrain(?:\s+is|\s+to)?\s+(.+)$/,
    /^(.+)\s+terrain$/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && TERRAIN_ALIASES[match[1]]) return TERRAIN_ALIASES[match[1]];
  }
  return null;
};

export const VOICE_INTENTS = Object.freeze({
  START: "start",
  STATUS: "status",
  PLANNED_WALK: "planned-walk",
  RESUME: "resume",
  SWITCH_HIP: "switch-hip",
  SWITCH_HAND: "switch-hand",
  MARK_CHANGE: "mark-change",
  TECHNIQUE_STATUS: "technique-status",
  CANCEL_COMPARISON: "cancel-comparison",
  COMPARE_RECENT: "compare-recent",
  SHOW_PREVIOUS: "show-previous",
  SET_TERRAIN: "set-terrain",
  QUIET: "quiet",
  PROMPTS_ON: "prompts-on",
  FINISH_REQUEST: "finish-request",
  FINISH_CONFIRM: "finish-confirm",
  FINISH_CANCEL: "finish-cancel",
  HELP: "help",
  VOICE_OFF: "voice-off",
  UNKNOWN: "unknown"
});

export function parseVoiceCommand(transcript, { awaitingFinishConfirmation = false } = {}) {
  const text = normalise(transcript)
    .replace(/^(hey\s+)?(run\s+)?coach\s+/, "")
    .trim();

  if (!text) return { intent: VOICE_INTENTS.UNKNOWN, transcript: text };

  if (awaitingFinishConfirmation) {
    if (matches(text, [/^(yes\s+)?confirm(\s+finish)?$/, /^yes\s+finish$/, /^finish\s+confirmed$/])) {
      return { intent: VOICE_INTENTS.FINISH_CONFIRM, transcript: text };
    }
    if (matches(text, [/^cancel(\s+finish)?$/, /^keep\s+running$/, /^do\s+not\s+finish$/])) {
      return { intent: VOICE_INTENTS.FINISH_CANCEL, transcript: text };
    }
  }

  if (matches(text, [/^(turn\s+)?voice\s+(off|control\s+off)$/, /^stop\s+listening$/])) {
    return { intent: VOICE_INTENTS.VOICE_OFF, transcript: text };
  }
  if (matches(text, [/^(start|begin)(\s+the)?\s+(run|coach|session)$/, /^start$/])) {
    return { intent: VOICE_INTENTS.START, transcript: text };
  }
  if (matches(text, [
    /^mark(\s+a|\s+the)?\s+(change|technique\s+change)$/,
    /^(start|begin)(\s+a|\s+the)?\s+(technique\s+)?comparison$/,
    /^(new|mark)(\s+a)?\s+technique\s+lap$/,
    /^technique\s+lap$/
  ])) {
    return { intent: VOICE_INTENTS.MARK_CHANGE, transcript: text };
  }
  if (matches(text, [
    /^technique\s+(status|update)$/,
    /^(change|comparison)\s+(status|update)$/,
    /^how\s+is\s+(the\s+)?(change|comparison)\s+going$/
  ])) {
    return { intent: VOICE_INTENTS.TECHNIQUE_STATUS, transcript: text };
  }
  if (matches(text, [
    /^cancel(\s+the)?\s+(change|comparison|technique\s+comparison|technique\s+lap)$/,
    /^stop(\s+the)?\s+(comparison|technique\s+comparison)$/
  ])) {
    return { intent: VOICE_INTENTS.CANCEL_COMPARISON, transcript: text };
  }

  const compareWindowMinutes = readWindowMinutes(text, [
    /^compare(?:\s+the)?\s+(?:last|recent)\s+(1|one|3|three|5|five|10|ten)(?:\s+minutes?)?$/,
    /^compare\s+(1|one|3|three|5|five|10|ten)\s+minutes?$/
  ]);
  if (compareWindowMinutes) {
    return {
      intent: VOICE_INTENTS.COMPARE_RECENT,
      transcript: text,
      windowMinutes: compareWindowMinutes
    };
  }

  const previousWindowMinutes = readWindowMinutes(text, [
    /^(?:show|review)(?:\s+me)?(?:\s+the)?\s+previous\s+(1|one|3|three|5|five|10|ten)(?:\s+minutes?)?$/,
    /^previous\s+(1|one|3|three|5|five|10|ten)(?:\s+minutes?)?$/
  ]);
  if (previousWindowMinutes) {
    return {
      intent: VOICE_INTENTS.SHOW_PREVIOUS,
      transcript: text,
      windowMinutes: previousWindowMinutes
    };
  }

  const terrain = readTerrain(text);
  if (terrain) {
    return { intent: VOICE_INTENTS.SET_TERRAIN, transcript: text, terrain };
  }
  if (matches(text, [/^(coach\s+)?status$/, /^run\s+(status|summary|update)$/, /^arm\s+(status|swing|update)$/, /^how\s+am\s+i\s+doing$/, /^update\s+me$/])) {
    return { intent: VOICE_INTENTS.STATUS, transcript: text };
  }
  if (matches(text, [/^(mark\s+)?(a\s+)?planned\s+walk$/, /^start\s+(a\s+)?walk(\s+break)?$/, /^walk\s+break$/])) {
    return { intent: VOICE_INTENTS.PLANNED_WALK, transcript: text };
  }
  if (matches(text, [/^resume(\s+running)?$/, /^back\s+to\s+running$/, /^end\s+(the\s+)?walk$/, /^continue(\s+run|\s+running)?$/])) {
    return { intent: VOICE_INTENTS.RESUME, transcript: text };
  }
  if (matches(text, [/^switch\s+to\s+(hip(\s+pocket)?|pocket)(\s+mode)?$/, /^(use|select)\s+(the\s+)?hip\s+pocket$/, /^hip\s+pocket\s+mode$/])) {
    return { intent: VOICE_INTENTS.SWITCH_HIP, transcript: text };
  }
  if (matches(text, [/^switch\s+to\s+(hand|arm)(\s+swing)?(\s+mode)?$/, /^(use|select)\s+(the\s+)?hand\s+swing$/, /^(hand|arm)\s+swing\s+mode$/])) {
    return { intent: VOICE_INTENTS.SWITCH_HAND, transcript: text };
  }
  if (matches(text, [/^(turn\s+)?(voice\s+)?prompts\s+on$/, /^automatic\s+coaching\s+on$/])) {
    return { intent: VOICE_INTENTS.PROMPTS_ON, transcript: text };
  }
  if (matches(text, [/^(go\s+)?quiet$/, /^(silence|mute)(\s+coach)?$/, /^quiet\s+(for\s+)?(ten|10)\s+minutes$/, /^(turn\s+)?(voice\s+)?prompts\s+off$/])) {
    return { intent: VOICE_INTENTS.QUIET, transcript: text };
  }
  if (matches(text, [/^(finish|end|complete)(\s+the)?\s+(run|session)$/, /^finish$/])) {
    return { intent: VOICE_INTENTS.FINISH_REQUEST, transcript: text };
  }
  if (matches(text, [/^(voice\s+)?help$/, /^commands$/, /^what\s+can\s+i\s+say$/])) {
    return { intent: VOICE_INTENTS.HELP, transcript: text };
  }
  return { intent: VOICE_INTENTS.UNKNOWN, transcript: text };
}

export class BrowserVoiceController {
  static fromWindow(windowRef, options = {}) {
    const Recognition = windowRef?.SpeechRecognition || windowRef?.webkitSpeechRecognition || null;
    return new BrowserVoiceController({ Recognition, documentRef: windowRef?.document, ...options });
  }

  constructor({
    Recognition = null,
    documentRef = null,
    language = "en-AU",
    restartDelayMs = 650,
    onTranscript = () => {},
    onState = () => {}
  } = {}) {
    this.Recognition = Recognition;
    this.documentRef = documentRef;
    this.language = language;
    this.restartDelayMs = restartDelayMs;
    this.onTranscript = onTranscript;
    this.onState = onState;
    this.recognition = null;
    this.restartTimer = null;
    this.enabled = false;
    this.listening = false;
    this.suspendedForSpeech = false;
    this.state = Recognition ? "off" : "unsupported";
  }

  get supported() {
    return Boolean(this.Recognition);
  }

  emitState(state, detail = null) {
    this.state = state;
    this.onState({ state, detail, enabled: this.enabled, listening: this.listening });
  }

  createRecognition() {
    if (this.recognition || !this.supported) return this.recognition;
    const recognition = new this.Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = this.language;
    recognition.maxAlternatives = 3;
    recognition.onstart = () => {
      this.listening = true;
      this.emitState("listening");
    };
    recognition.onresult = event => {
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal === false) continue;
        const alternatives = Array.from(result)
          .map(item => String(item?.transcript || "").trim())
          .filter(Boolean);
        if (alternatives.length) this.onTranscript(alternatives);
      }
    };
    recognition.onerror = event => {
      const error = event?.error || "unknown";
      if (["not-allowed", "service-not-allowed"].includes(error)) {
        this.enabled = false;
        this.listening = false;
        this.emitState("denied", error);
        return;
      }
      if (error === "audio-capture") {
        this.enabled = false;
        this.listening = false;
        this.emitState("no-microphone", error);
        return;
      }
      if (error !== "aborted") this.emitState("reconnecting", error);
    };
    recognition.onend = () => {
      this.listening = false;
      if (this.enabled && !this.suspendedForSpeech) this.scheduleRestart();
      else if (!this.enabled) this.emitState("off");
    };
    this.recognition = recognition;
    return recognition;
  }

  enable() {
    if (!this.supported) {
      this.emitState("unsupported");
      return false;
    }
    this.enabled = true;
    this.suspendedForSpeech = false;
    this.startListening();
    return true;
  }

  disable() {
    this.enabled = false;
    this.suspendedForSpeech = false;
    this.clearRestart();
    try { this.recognition?.abort(); } catch (_) {}
    this.listening = false;
    this.emitState("off");
  }

  pauseForSpeech() {
    if (!this.enabled) return;
    this.suspendedForSpeech = true;
    this.clearRestart();
    try { this.recognition?.stop(); } catch (_) {}
    this.listening = false;
    this.emitState("speaking");
  }

  resumeAfterSpeech() {
    if (!this.enabled) return;
    this.suspendedForSpeech = false;
    this.scheduleRestart(300);
  }

  setPageVisible(visible) {
    if (!visible) {
      this.clearRestart();
      try { this.recognition?.stop(); } catch (_) {}
      this.listening = false;
      return;
    }
    if (this.enabled && !this.suspendedForSpeech) this.scheduleRestart(200);
  }

  startListening() {
    if (!this.enabled || this.suspendedForSpeech || this.listening) return;
    if (this.documentRef?.visibilityState === "hidden") return;
    this.clearRestart();
    const recognition = this.createRecognition();
    if (!recognition) return;
    try {
      this.emitState("starting");
      recognition.start();
    } catch (_) {
      this.scheduleRestart();
    }
  }

  scheduleRestart(delayMs = this.restartDelayMs) {
    if (!this.enabled || this.suspendedForSpeech || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startListening();
    }, delayMs);
  }

  clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}
