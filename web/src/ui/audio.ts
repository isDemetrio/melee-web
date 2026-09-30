/**
 * Audio bootstrap.
 *
 * The specification is explicit (docs/SPEC_PIANO.md §2.1): the AudioContext may only be
 * created or resumed after a user gesture. The boot screen's button is that gesture, and
 * this module is the only place allowed to touch AudioContext, so the rule cannot be
 * broken by accident somewhere else.
 *
 * The mixer itself produces 32 kHz through a ring buffer in shared memory, read by an
 * AudioWorklet. That worklet belongs to the WASM core work, which needs the game build;
 * what exists here is the unlock, the sample rate negotiation, and a silent worklet
 * placeholder that proves the plumbing on a real device.
 */

export interface AudioStatus {
  readonly state: AudioContextState | 'unsupported';
  readonly sampleRate: number | null;
  readonly workletLoaded: boolean;
}

const WORKLET_SOURCE = `
// Silent placeholder. The real processor reads the mixer's ring buffer from shared
// memory; it exists now so the unlock path and the worklet registration are proven on
// real devices before the game core lands.
class MeleeMixerProcessor extends AudioWorkletProcessor {
  process(_inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }
}
registerProcessor('melee-mixer', MeleeMixerProcessor);
`;

export class AudioBootstrap {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private workletLoaded = false;

  /**
   * Must be called from a user-gesture handler. Returns the resulting status instead of
   * throwing: a browser that refuses to start audio should degrade to a silent game, not
   * a broken one.
   */
  async unlock(): Promise<AudioStatus> {
    if (typeof AudioContext !== 'function') {
      return { state: 'unsupported', sampleRate: null, workletLoaded: false };
    }

    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    try {
      await this.context.resume();
    } catch {
      return this.status();
    }

    if (!this.workletLoaded && typeof AudioWorkletNode === 'function') {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        await this.context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this.node = new AudioWorkletNode(this.context, 'melee-mixer', { numberOfOutputs: 1 });
        this.node.connect(this.context.destination);
        this.workletLoaded = true;
      } catch {
        // A worklet failure is not fatal: the game can run silent.
        this.workletLoaded = false;
      }
    }

    return this.status();
  }

  status(): AudioStatus {
    return {
      state: this.context?.state ?? 'unsupported',
      sampleRate: this.context?.sampleRate ?? null,
      workletLoaded: this.workletLoaded,
    };
  }

  setVolume(value: number): void {
    if (!this.context) return;
    // The master gain belongs on the worklet's output once it exists; until then this is
    // a no-op that keeps the settings path honest.
    void value;
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.context?.close();
    this.context = null;
    this.workletLoaded = false;
  }
}
