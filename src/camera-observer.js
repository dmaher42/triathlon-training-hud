import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const FEATURE_FLOORS = {
  torsoAngle: 2,
  torsoOffset: 0.035,
  worldTorsoTilt: 2,
  headOffset: 0.05,
  armWristHeight: 0.08,
  armElbowAngle: 5
};

const CORE_FEATURES = new Set(["torsoAngle", "torsoOffset", "worldTorsoTilt"]);
const ARM_FEATURES = new Set(["armWristHeight", "armElbowAngle"]);
const IGNORED_CLASSIFICATION_FEATURES = new Set(["headOffset"]);
const ARM_FEATURE_WEIGHT = 0.85;
const LEARNING_SAMPLE_WINDOW_MS = 1800;
const MAX_LEARNING_SAMPLES = 14;
const MAX_CALIBRATION_SAMPLES_PER_POSE = 90;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mad = values => {
  const center = median(values);
  return median(values.map(value => Math.abs(value - center)));
};

const point = (a, b) => {
  const aVisibility = a.visibility ?? 1;
  const bVisibility = b.visibility ?? 1;
  const visibilityTotal = aVisibility + bVisibility;
  const aWeight = visibilityTotal ? aVisibility / visibilityTotal : .5;
  const bWeight = visibilityTotal ? bVisibility / visibilityTotal : .5;
  return {
    x: a.x * aWeight + b.x * bWeight,
    y: a.y * aWeight + b.y * bWeight,
    z: (a.z || 0) * aWeight + (b.z || 0) * bWeight,
    // Side-on riding naturally hides the far shoulder or hip. Use the pair's
    // combined confidence so one clear side can keep the torso track alive.
    visibility: visibilityTotal / 2
  };
};

const distance2d = (a, b, aspect = 1) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
const angleAt = (a, b, c, aspect = 1) => {
  const ab = { x: (a.x - b.x) * aspect, y: a.y - b.y };
  const cb = { x: (c.x - b.x) * aspect, y: c.y - b.y };
  const denominator = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!denominator) return null;
  return Math.acos(Math.max(-1, Math.min(1, (ab.x * cb.x + ab.y * cb.y) / denominator))) * 180 / Math.PI;
};

export class CameraObserver {
  constructor({ video, onUpdate = () => {} }) {
    this.video = video;
    this.onUpdate = onUpdate;
    this.stream = null;
    this.landmarker = null;
    this.loopId = 0;
    this.lastInferenceAt = 0;
    this.status = "off";
    this.error = "";
    this.rawState = "uncertain";
    this.stableState = "uncertain";
    this.confidence = 0;
    this.reason = "not calibrated";
    this.history = [];
    this.calibration = null;
    this.capture = null;
    this.recentSamples = [];
    this.learningCandidate = [];
    this.sessionActive = false;
    this.context = { rideSec: 0, manualAero: false };
    this.lastSessionAt = 0;
    this.totalsMs = { aero: 0, upright: 0, uncertain: 0 };
    this.classifiableMs = 0;
    this.agreementMs = 0;
    this.segments = [];
    this.currentSegment = null;
  }

  async start() {
    if (this.stream && this.landmarker) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires Chrome or Edge on localhost.");
    this.status = "loading";
    this.notify();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" }
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      const assetBase = import.meta.env.BASE_URL;
      const vision = await FilesetResolver.forVisionTasks(`${assetBase}wasm`);
      this.landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: `${assetBase}models/pose_landmarker_lite.task` },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.55,
        minPosePresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
        outputSegmentationMasks: false
      });
      this.status = "framing";
      this.reason = "Position the laptop to show your shoulders, hips and arms.";
      this.loop();
      this.notify();
    } catch (error) {
      this.status = "error";
      this.error = error?.message || "Camera could not start.";
      this.stopStream();
      this.notify();
      throw error;
    }
  }

  async stop() {
    cancelAnimationFrame(this.loopId);
    this.loopId = 0;
    this.stopStream();
    if (this.landmarker) this.landmarker.close();
    this.landmarker = null;
    this.capture = null;
    this.calibration = null;
    this.history = [];
    this.recentSamples = [];
    this.learningCandidate = [];
    this.rawState = "uncertain";
    this.stableState = "uncertain";
    this.confidence = 0;
    this.status = "off";
  }

  stopStream() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  loop = () => {
    this.loopId = requestAnimationFrame(this.loop);
    const timestamp = performance.now();
    if (!this.landmarker || this.video.readyState < 2 || timestamp - this.lastInferenceAt < 110) return;
    this.lastInferenceAt = timestamp;
    let sample = null;
    try {
      const result = this.landmarker.detectForVideo(this.video, timestamp);
      sample = this.extractFeatures(result);
    } catch (error) {
      this.reason = "Pose processing paused.";
    }
    this.processSample(sample, timestamp);
  };

  extractFeatures(result) {
    const landmarks = result?.landmarks?.[0];
    const world = result?.worldLandmarks?.[0];
    if (!landmarks) return null;
    const shoulder = point(landmarks[11], landmarks[12]);
    const hip = point(landmarks[23], landmarks[24]);
    const visibility = Math.min(shoulder.visibility, hip.visibility);
    const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);
    const torsoLength = distance2d(shoulder, hip, aspect);
    if (visibility < 0.58 || torsoLength < 0.075) return null;
    if ([shoulder, hip].some(item => item.x < 0.025 || item.x > 0.975 || item.y < 0.025 || item.y > 0.975)) return null;

    const dx = (shoulder.x - hip.x) * aspect;
    const dy = shoulder.y - hip.y;
    const features = {
      torsoAngle: Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI,
      torsoOffset: dx / torsoLength
    };

    if (world) {
      const worldShoulder = point(world[11], world[12]);
      const worldHip = point(world[23], world[24]);
      features.worldTorsoTilt = Math.atan2(
        Math.hypot(worldShoulder.x - worldHip.x, worldShoulder.z - worldHip.z),
        Math.abs(worldShoulder.y - worldHip.y)
      ) * 180 / Math.PI;
    }

    const ears = point(landmarks[7], landmarks[8]);
    if (ears.visibility > 0.5) features.headOffset = ((ears.x - hip.x) * aspect) / torsoLength;
    const arms = [[11, 13, 15], [12, 14, 16]].map(indices => {
      const armVisibility = Math.min(...indices.map(index => landmarks[index].visibility ?? 1));
      if (armVisibility <= 0.45) return null;
      return {
        visibility: armVisibility,
        elbowAngle: angleAt(landmarks[indices[0]], landmarks[indices[1]], landmarks[indices[2]], aspect),
        wristHeight: (landmarks[indices[2]].y - landmarks[indices[0]].y) / torsoLength
      };
    }).filter(Boolean);
    if (arms.length) {
      const visibilityTotal = arms.reduce((sum, arm) => sum + arm.visibility, 0);
      features.armElbowAngle = arms.reduce((sum, arm) => sum + arm.elbowAngle * arm.visibility, 0) / visibilityTotal;
      features.armWristHeight = arms.reduce((sum, arm) => sum + arm.wristHeight * arm.visibility, 0) / visibilityTotal;
    }
    return { features, quality: visibility };
  }

  async capturePose(label, seconds = 4) {
    if (!this.landmarker) throw new Error("Camera is not ready.");
    if (this.capture) throw new Error("A calibration capture is already running.");
    this.status = "calibrating";
    this.reason = `Hold ${label} position`;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      this.capture = {
        label,
        samples: [],
        collectAt: startedAt + 800,
        endsAt: startedAt + 800 + seconds * 1000,
        resolve,
        reject
      };
      this.notify();
    });
  }

  processSample(sample, timestamp) {
    if (this.capture) {
      if (sample && timestamp >= this.capture.collectAt) this.capture.samples.push(sample.features);
      if (timestamp >= this.capture.endsAt) this.finishCapture();
      this.notify();
      return;
    }
    if (!this.calibration) {
      this.rawState = sample ? "uncertain" : "uncertain";
      this.confidence = sample?.quality || 0;
      this.reason = sample ? "Pose visible; calibration required." : "Move into the camera frame.";
      this.notify();
      return;
    }
    if (sample) {
      this.recentSamples.push({ timestamp, features: { ...sample.features }, quality: sample.quality });
      this.recentSamples = this.recentSamples.filter(item => timestamp - item.timestamp <= LEARNING_SAMPLE_WINDOW_MS);
    }
    const classification = this.classify(sample);
    this.rawState = classification.state;
    this.confidence = classification.confidence;
    this.reason = classification.reason;
    this.updateStableState(timestamp);
    this.integrateSession(timestamp);
    this.notify();
  }

  finishCapture() {
    const capture = this.capture;
    this.capture = null;
    if (capture.samples.length < 20) {
      this.status = "framing";
      capture.reject(new Error("Not enough clear pose samples. Move the camera so shoulders and hips remain visible."));
      return;
    }
    this.calibration ??= { upright: null, aero: null, profile: null, quality: 0 };
    this.calibration[capture.label] = capture.samples;
    this.status = "framing";
    capture.resolve({ count: capture.samples.length });
  }

  finalizeCalibration() {
    const upright = this.calibration?.upright;
    const aero = this.calibration?.aero;
    if (!upright?.length || !aero?.length) throw new Error("Capture both positions first.");
    const keys = [...new Set([...upright.flatMap(Object.keys), ...aero.flatMap(Object.keys)])];
    const profile = {};
    for (const key of keys) {
      // Head carriage changes naturally while riding and must not decide whether
      // the torso is still in the calibrated Aero position.
      if (IGNORED_CLASSIFICATION_FEATURES.has(key)) continue;
      const u = upright.map(item => item[key]).filter(Number.isFinite);
      const a = aero.map(item => item[key]).filter(Number.isFinite);
      if (u.length < upright.length * .75 || a.length < aero.length * .75) continue;
      const uprightMedian = median(u);
      const aeroMedian = median(a);
      const scale = Math.max(FEATURE_FLOORS[key] || .04, 1.4826 * (mad(u) + mad(a)) / 2);
      const separation = Math.abs(aeroMedian - uprightMedian) / scale;
      if (separation < .55) continue;
      const roleWeight = ARM_FEATURES.has(key) ? ARM_FEATURE_WEIGHT : 1;
      profile[key] = { upright: uprightMedian, aero: aeroMedian, scale, separation, weight: Math.min(9, separation * separation) * roleWeight };
    }
    const torsoKeys = ["torsoAngle", "torsoOffset", "worldTorsoTilt"].filter(key => profile[key]);
    if (!torsoKeys.length || Object.keys(profile).length < 2) {
      throw new Error("Positions look too similar. Use a clearer side or three-quarter camera angle and recalibrate.");
    }
    const quality = Math.min(100, Math.round(Object.values(profile).reduce((sum, item) => sum + Math.min(4, item.separation), 0) / (Object.keys(profile).length * 4) * 100));
    this.calibration.profile = profile;
    this.calibration.quality = quality;
    this.calibration.features = Object.keys(profile);
    this.status = "ready";
    this.reason = "Passive observation ready.";
    this.history = [];
    this.notify();
    return { quality, features: Object.keys(profile) };
  }

  stageLearningCandidate(timestamp = performance.now()) {
    this.learningCandidate = this.recentSamples
      .filter(item => timestamp - item.timestamp <= LEARNING_SAMPLE_WINDOW_MS && item.quality >= .45)
      .slice(-MAX_LEARNING_SAMPLES)
      .map(item => ({ ...item.features }));
    return { count: this.learningCandidate.length };
  }

  applyLearningFeedback(label) {
    if (!["aero", "upright"].includes(label) || !this.calibration?.profile) {
      return { learned: false, count: 0 };
    }
    const samples = this.learningCandidate;
    this.learningCandidate = [];
    if (samples.length < 5) return { learned: false, count: samples.length };
    this.calibration[label] = [...this.calibration[label], ...samples].slice(-MAX_CALIBRATION_SAMPLES_PER_POSE);
    const result = this.finalizeCalibration();
    this.rawState = label;
    this.stableState = label;
    this.confidence = .95;
    this.reason = `Learned a confirmed ${label} variation.`;
    this.history = [];
    this.notify();
    return { learned: true, count: samples.length, quality: result.quality, label };
  }

  classify(sample) {
    if (!sample) return { state: "uncertain", confidence: 0, reason: "Pose not clearly visible." };
    const allEntries = Object.entries(this.calibration.profile).filter(([key]) => !IGNORED_CLASSIFICATION_FEATURES.has(key));
    const entries = allEntries.filter(([key]) => Number.isFinite(sample.features[key]));
    const coreEntries = entries.filter(([key]) => CORE_FEATURES.has(key));
    if (!coreEntries.length) return { state: "uncertain", confidence: sample.quality, reason: "Torso landmarks are not clear enough." };
    if (entries.length < Math.ceil(allEntries.length * .5)) return { state: "uncertain", confidence: sample.quality, reason: "Not enough body landmarks visible." };

    const positionScore = selectedEntries => {
      if (!selectedEntries.length) return null;
      let scoreTotal = 0;
      let weightTotal = 0;
      let extremeCount = 0;
      for (const [key, item] of selectedEntries) {
        const classRange = item.aero - item.upright;
        if (Math.abs(classRange) < 1e-6) continue;
        const rawPosition = (sample.features[key] - item.upright) / classRange;
        if (rawPosition < -1.5 || rawPosition > 2.5) extremeCount += 1;
        const position = Math.max(-.35, Math.min(1.35, rawPosition));
        scoreTotal += position * item.weight;
        weightTotal += item.weight;
      }
      return weightTotal ? { score: scoreTotal / weightTotal, extremeCount } : null;
    };

    const core = positionScore(coreEntries);
    const arms = positionScore(entries.filter(([key]) => ARM_FEATURES.has(key)));
    if (!core || core.extremeCount > coreEntries.length / 2) return { state: "uncertain", confidence: .2, reason: "Torso is outside the calibrated riding range." };
    if (arms?.extremeCount > 1) return { state: "uncertain", confidence: .25, reason: "Arm position is outside the calibrated riding range." };

    const coreAero = core.score >= .62;
    const armsAero = arms?.score >= .62;
    const coreAllowsAero = core.score >= .34;
    const armsAllowAero = !arms || arms.score >= .34;
    if ((coreAero && armsAllowAero) || (armsAero && coreAllowsAero)) {
      const strength = Math.max(core.score, arms?.score ?? core.score);
      return { state: "aero", confidence: Math.min(1, .55 + Math.max(0, strength - .5) * .8), reason: arms ? "Arm support and torso are inside the Aero zone." : "Torso is inside the Aero zone." };
    }

    const coreUpright = core.score <= .38;
    const armsAllowUpright = !arms || arms.score <= .55;
    if (coreUpright && armsAllowUpright) {
      return { state: "upright", confidence: Math.min(1, .6 + Math.max(0, .38 - core.score)), reason: "Torso matches the calibrated upright zone." };
    }

    return { state: "uncertain", confidence: .35, reason: arms && Math.abs(core.score - arms.score) > .35 ? "Arms and torso disagree." : "Between calibrated riding zones." };
  }

  updateStableState(timestamp) {
    this.history.push({ state: this.rawState, timestamp });
    this.history = this.history.filter(item => timestamp - item.timestamp <= 1600);
    const duration = this.history.length > 1 ? timestamp - this.history[0].timestamp : 0;
    const ratio = state => this.history.filter(item => item.state === state).length / this.history.length;
    let next = this.stableState;
    if (duration >= 1450 && ratio("aero") >= .8) next = "aero";
    else if (duration >= 950 && ratio("upright") >= .8) next = "upright";
    else {
      const recent = this.history.filter(item => timestamp - item.timestamp <= 800);
      if (recent.length && recent.filter(item => item.state === "uncertain").length / recent.length >= .75) next = "uncertain";
    }
    if (next !== this.stableState) {
      this.closeSegment(this.context.rideSec);
      this.stableState = next;
      this.currentSegment = { state: next, startRideSec: this.context.rideSec, confidenceTotal: 0, samples: 0 };
    }
  }

  beginSession() {
    this.sessionActive = true;
    this.lastSessionAt = performance.now();
    this.totalsMs = { aero: 0, upright: 0, uncertain: 0 };
    this.classifiableMs = 0;
    this.agreementMs = 0;
    this.segments = [];
    this.currentSegment = { state: this.stableState, startRideSec: 0, confidenceTotal: 0, samples: 0 };
  }

  setSessionContext(context) { this.context = context; }

  integrateSession(timestamp) {
    if (!this.sessionActive) return;
    const elapsed = Math.max(0, Math.min(500, timestamp - this.lastSessionAt));
    this.lastSessionAt = timestamp;
    this.totalsMs[this.stableState] += elapsed;
    if (this.stableState !== "uncertain") {
      this.classifiableMs += elapsed;
      if ((this.stableState === "aero") === this.context.manualAero) this.agreementMs += elapsed;
    }
    if (this.currentSegment) {
      this.currentSegment.confidenceTotal += this.confidence;
      this.currentSegment.samples += 1;
    }
  }

  closeSegment(endRideSec) {
    if (!this.currentSegment) return;
    const durationSec = Math.max(0, endRideSec - this.currentSegment.startRideSec);
    if (durationSec > .2) this.segments.push({
      state: this.currentSegment.state,
      startRideSec: this.currentSegment.startRideSec,
      endRideSec,
      durationSec,
      averageConfidence: this.currentSegment.samples ? this.currentSegment.confidenceTotal / this.currentSegment.samples : 0
    });
    this.currentSegment = null;
  }

  endSession(rideSeconds) {
    this.integrateSession(performance.now());
    this.closeSegment(rideSeconds);
    this.sessionActive = false;
    const classifiable = this.classifiableMs / 1000;
    const observed = (this.totalsMs.aero + this.totalsMs.upright + this.totalsMs.uncertain) / 1000;
    const aeroSegments = this.segments.filter(item => item.state === "aero");
    return {
      enabled: true,
      calibrationQuality: this.calibration?.quality || 0,
      calibrationFeatures: this.calibration?.features || [],
      observedSeconds: observed,
      coveragePercent: rideSeconds ? Math.round(observed / rideSeconds * 100) : 0,
      detectedAeroSeconds: this.totalsMs.aero / 1000,
      detectedUprightSeconds: this.totalsMs.upright / 1000,
      uncertainSeconds: this.totalsMs.uncertain / 1000,
      detectedAeroPercent: classifiable ? Math.round(this.totalsMs.aero / 10 / classifiable) : 0,
      agreementPercent: classifiable ? Math.round(this.agreementMs / 10 / classifiable) : 0,
      longestAeroSeconds: aeroSegments.reduce((best, item) => Math.max(best, item.durationSec), 0),
      transitions: Math.max(0, this.segments.length - 1),
      segments: this.segments
    };
  }

  getSnapshot() {
    return {
      status: this.status,
      error: this.error,
      rawState: this.rawState,
      stableState: this.stableState,
      confidence: this.confidence,
      reason: this.reason,
      calibrationQuality: this.calibration?.quality || 0,
      capture: this.capture ? {
        label: this.capture.label,
        remaining: Math.max(0, (this.capture.endsAt - performance.now()) / 1000),
        samples: this.capture.samples.length
      } : null
    };
  }

  notify() { this.onUpdate(this.getSnapshot()); }
}
