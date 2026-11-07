// src/audio/fx.js
var FX_TYPES = ["eq", "compressor", "limiter", "reverb", "delay", "duck", "pitch"];
var MAX_EQ_BANDS = 6;
function defaultFx(type) {
  switch (type) {
    case "eq":
      return { type: "eq", bands: [{ type: "peaking", freqHz: 1e3, gainDb: 0, q: 1 }] };
    case "compressor":
      return { type: "compressor", thresholdDb: -18, ratio: 3, attackSec: 0.01, releaseSec: 0.12, kneeDb: 6, makeupDb: 0 };
    case "limiter":
      return { type: "limiter", ceilingDb: -1, releaseSec: 0.08 };
    case "reverb":
      return { type: "reverb", roomSize: 0.6, damping: 0.4, wet: 0.28, dry: 0.85, width: 0.8 };
    case "delay":
      return { type: "delay", timeSec: 0.28, feedback: 0.3, wet: 0.22, dry: 0.85, pingPong: false };
    case "duck":
      return { type: "duck", sourceTrackId: "", targetDb: -9, thresholdDb: -42, attackSec: 0.12, releaseSec: 0.4 };
    case "pitch":
      return { type: "pitch", rate: 1, pitchSemitones: 0, preservePitch: false };
    default:
      throw new Error(`unknown effect type "${type}"; use ${FX_TYPES.join(", ")}`);
  }
}
function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function resolveFx(fx) {
  const base = defaultFx(fx?.type);
  switch (base.type) {
    case "eq": {
      const bands = Array.isArray(fx?.bands) ? fx.bands.slice(0, MAX_EQ_BANDS) : base.bands;
      return {
        type: "eq",
        bands: bands.map((band) => {
          const type = ["peaking", "lowshelf", "highshelf"].includes(band?.type) ? band.type : "peaking";
          return {
            type,
            freqHz: clamp(num(band?.freqHz, 1e3), 20, 2e4),
            gainDb: clamp(num(band?.gainDb, 0), -24, 24),
            q: clamp(num(band?.q, 1), 0.1, 18)
          };
        })
      };
    }
    case "compressor":
      return {
        type: "compressor",
        thresholdDb: clamp(num(fx?.thresholdDb, base.thresholdDb), -60, 0),
        ratio: clamp(num(fx?.ratio, base.ratio), 1, 20),
        attackSec: clamp(num(fx?.attackSec, base.attackSec), 1e-3, 1),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2),
        kneeDb: clamp(num(fx?.kneeDb, base.kneeDb), 0, 40),
        makeupDb: clamp(num(fx?.makeupDb, base.makeupDb), -24, 24)
      };
    case "limiter":
      return {
        type: "limiter",
        ceilingDb: clamp(num(fx?.ceilingDb, base.ceilingDb), -12, 0),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2)
      };
    case "reverb":
      return {
        type: "reverb",
        roomSize: clamp(num(fx?.roomSize, base.roomSize), 0, 1),
        damping: clamp(num(fx?.damping, base.damping), 0, 1),
        wet: clamp(num(fx?.wet, base.wet), 0, 1),
        dry: clamp(num(fx?.dry, base.dry), 0, 1),
        width: clamp(num(fx?.width, base.width), 0, 1)
      };
    case "delay":
      return {
        type: "delay",
        timeSec: clamp(num(fx?.timeSec, base.timeSec), 0.01, 2),
        feedback: clamp(num(fx?.feedback, base.feedback), 0, 0.95),
        wet: clamp(num(fx?.wet, base.wet), 0, 1),
        dry: clamp(num(fx?.dry, base.dry), 0, 1),
        pingPong: fx?.pingPong === true
      };
    case "duck":
      return {
        type: "duck",
        sourceTrackId: typeof fx?.sourceTrackId === "string" ? fx.sourceTrackId.trim() : "",
        targetDb: clamp(num(fx?.targetDb, base.targetDb), -40, 0),
        thresholdDb: clamp(num(fx?.thresholdDb, base.thresholdDb), -60, 0),
        attackSec: clamp(num(fx?.attackSec, base.attackSec), 1e-3, 1),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2)
      };
    case "pitch":
      return {
        type: "pitch",
        rate: clamp(num(fx?.rate, 1), 0.25, 4),
        pitchSemitones: clamp(num(fx?.pitchSemitones, 0), -12, 12),
        preservePitch: fx?.preservePitch === true
      };
    default:
      throw new Error(`unknown effect type "${fx?.type}"`);
  }
}
var COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
var ALLPASS_TUNING = [556, 441, 341, 225];
var STEREO_SPREAD = 23;
var FIXED_GAIN = 0.015;
function createReverbProcessor(sampleRate2, fx) {
  const resolved = resolveFx(fx);
  const scale = sampleRate2 / 44100;
  const feedback = resolved.roomSize * 0.28 + 0.7;
  const damp1 = resolved.damping * 0.4;
  const damp2 = 1 - damp1;
  const wet1 = resolved.wet * (resolved.width / 2 + 0.5);
  const wet2 = resolved.wet * ((1 - resolved.width) / 2);
  const dry = resolved.dry;
  const makeBank = (offset) => ({
    combs: COMB_TUNING.map((tuning) => ({
      buffer: new Float32Array(Math.max(1, Math.round((tuning + offset) * scale))),
      index: 0,
      store: 0
    })),
    allpasses: ALLPASS_TUNING.map((tuning) => ({
      buffer: new Float32Array(Math.max(1, Math.round((tuning + offset) * scale))),
      index: 0
    }))
  });
  const left = makeBank(0);
  const right = makeBank(STEREO_SPREAD);
  const runBank = (bank, inputLeft, inputRight, output, count) => {
    for (let i = 0; i < count; i++) {
      const input = (inputLeft[i] + inputRight[i]) * FIXED_GAIN;
      let sample = 0;
      for (const comb of bank.combs) {
        const buffer = comb.buffer;
        const index = comb.index;
        const stored = buffer[index];
        comb.store = stored * damp2 + comb.store * damp1;
        buffer[index] = input + comb.store * feedback;
        comb.index = index + 1 >= buffer.length ? 0 : index + 1;
        sample += stored;
      }
      for (const allpass of bank.allpasses) {
        const buffer = allpass.buffer;
        const index = allpass.index;
        const stored = buffer[index];
        buffer[index] = sample + stored * 0.5;
        allpass.index = index + 1 >= buffer.length ? 0 : index + 1;
        sample = stored - sample;
      }
      output[i] = sample;
    }
  };
  let wetLeft = new Float32Array(128);
  let wetRight = new Float32Array(128);
  return {
    /**
     * Process one block in place. Blocks may be any length; state carries over, so
     * a 128-frame worklet block and one 15-minute buffer give the same result.
     */
    process(channels, frames = channels[0].length) {
      if (wetLeft.length < frames) {
        wetLeft = new Float32Array(frames);
        wetRight = new Float32Array(frames);
      }
      const inputLeft = channels[0];
      const inputRight = channels[1] ?? channels[0];
      runBank(left, inputLeft, inputRight, wetLeft, frames);
      runBank(right, inputLeft, inputRight, wetRight, frames);
      for (let i = 0; i < frames; i++) {
        const dryLeft = inputLeft[i] * dry;
        const dryRight = inputRight[i] * dry;
        channels[0][i] = dryLeft + wetLeft[i] * wet1 + wetRight[i] * wet2;
        if (channels[1]) channels[1][i] = dryRight + wetRight[i] * wet1 + wetLeft[i] * wet2;
      }
      return channels;
    }
  };
}

// src/client/clipbay/reverb-worklet.js
var ReverbProcessor = class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const payload = options?.processorOptions ?? {};
    this.sampleRateIn = payload.sampleRate || sampleRate;
    this.processor = createReverbProcessor(this.sampleRateIn, payload.fx ?? { type: "reverb" });
    this.active = true;
    this.port.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.type === "params") {
        this.processor = createReverbProcessor(this.sampleRateIn, data.fx ?? { type: "reverb" });
      } else if (data.type === "stop") {
        this.active = false;
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    if (input && input.length > 0) {
      left.set(input[0].subarray(0, frames));
      right.set((input[1] ?? input[0]).subarray(0, frames));
    }
    const processed = this.processor.process([left, right], frames);
    output[0].set(processed[0]);
    if (output[1]) output[1].set(processed[1] ?? processed[0]);
    return this.active;
  }
};
registerProcessor("anyaudio-reverb", ReverbProcessor);
