/**
 * The reverb, running inside an AudioWorklet (improvement plan 02, I-07).
 *
 * Why a worklet at all: the preview must sound like the export. Five of the seven
 * effects map onto WebAudio nodes closely enough to be worth using, but a reverb
 * has no native equivalent that sounds like this one — `ConvolverNode` needs an
 * impulse response, and the renderer uses Freeverb, so a convolution reverb would
 * be a different reverb. Measured too: a 2048-tap convolution over a 15-minute
 * project takes 81s, Freeverb takes 1.3s.
 *
 * So this file is a wrapper, not an implementation: it imports `createReverbProcessor`
 * from `src/audio/fx.js` and registers it under a name. The bundle inlines that
 * module here, which is the point — one source, two runtimes. If these ever drift
 * apart, the person hears one reverb and exports another, which is the exact
 * failure this whole plan exists to prevent.
 *
 * Loaded by the client through a blob URL, which needs a secure context: DSH runs
 * on http://127.0.0.1, so it qualifies (verified on the real UI, plan §1.1).
 */
import { createReverbProcessor } from '../../audio/fx.js'

class ReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const payload = options?.processorOptions ?? {}
    this.sampleRateIn = payload.sampleRate || sampleRate
    this.processor = createReverbProcessor(this.sampleRateIn, payload.fx ?? { type: 'reverb' })
    this.active = true
    // The main thread can swap the effect parameters or stop the node without
    // tearing down the graph; a stopped node has to stay alive until it says so,
    // because `process` returning false is the only way to end it.
    this.port.onmessage = (event) => {
      const data = event.data ?? {}
      if (data.type === 'params') {
        this.processor = createReverbProcessor(this.sampleRateIn, data.fx ?? { type: 'reverb' })
      } else if (data.type === 'stop') {
        this.active = false
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const frames = output[0].length
    if (!input || input.length === 0) {
      // No input yet: emit silence rather than a stale tail, or a reverb node
      // that was never connected would ring on its own.
      for (const channel of output) channel.fill(0)
      return true
    }
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    left.set(input[0].subarray(0, frames))
    right.set((input[1] ?? input[0]).subarray(0, frames))
    const processed = this.processor.process([left, right], frames)
    output[0].set(processed[0])
    if (output[1]) output[1].set(processed[1] ?? processed[0])
    return this.active
  }
}

registerProcessor('anyaudio-reverb', ReverbProcessor)
