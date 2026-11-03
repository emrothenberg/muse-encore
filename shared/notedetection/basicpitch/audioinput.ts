// SPDX-License-Identifier: Apache-2.0
// MuseEncore: demo/audio-input.ts of basic-pitch-ts (its live microphone demo); changed: the recorder can send the
// audio to a MessagePort (a worker), StreamResampler is exported, the microphone is opened and closed by
// ../microphone.ts and a stop while the browser asks for it ends the start (see LICENSE).
/*
 * Copyright 2022 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { acquireMicrophone, releaseMicrophone, stopMicrophone } from '../microphone';

export const MODEL_SAMPLE_RATE = 22050;

// Collects mono audio in blocks of 1024 samples and posts them to the main thread
// (or to the MessagePort sent to it: { port }).
const RECORDER_WORKLET = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.length = 0;
    this.target = this.port;
    this.port.onmessage = event => {
      if (event.data && event.data.port) this.target = event.data.port;
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const n = channels[0].length;
      for (let i = 0; i < n; ++i) {
        let sum = 0;
        for (let c = 0; c < channels.length; ++c) sum += channels[c][i];
        this.block[this.length++] = sum / channels.length;
        if (this.length === this.block.length) {
          this.target.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(1024);
          this.length = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
`;

/**
 * Streaming resampler (windowed-sinc low pass + linear interpolation), only
 * used when the browser can't run an AudioContext at 22050Hz.
 */
export class StreamResampler {
  private readonly ratio: number;
  private readonly taps: Float32Array;
  private history: Float32Array;
  private position = 0;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
    const nTaps = 63;
    const cutoff = (0.45 * outputRate) / inputRate; // relative to input rate
    this.taps = new Float32Array(nTaps);
    let sum = 0;
    for (let i = 0; i < nTaps; ++i) {
      const x = i - (nTaps - 1) / 2;
      const sinc =
        x === 0
          ? 2 * cutoff
          : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const blackman =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (nTaps - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (nTaps - 1));
      this.taps[i] = sinc * blackman;
      sum += this.taps[i];
    }
    this.taps.forEach((t, i) => (this.taps[i] = t / sum));
    this.history = new Float32Array(nTaps - 1);
  }

  process(input: Float32Array): Float32Array {
    const nTaps = this.taps.length;
    // filter input (prepend the previous samples so the filter is continuous)
    const padded = new Float32Array(this.history.length + input.length);
    padded.set(this.history);
    padded.set(input, this.history.length);
    const filtered = new Float32Array(input.length);
    for (let i = 0; i < input.length; ++i) {
      let acc = 0;
      for (let t = 0; t < nTaps; ++t) acc += padded[i + t] * this.taps[t];
      filtered[i] = acc;
    }
    this.history = padded.slice(padded.length - (nTaps - 1));

    // pick output samples, interpolating from the last sample of the previous block
    const buffer = new Float32Array(filtered.length + 1);
    buffer[0] = this.previousSample;
    buffer.set(filtered, 1);
    const output: number[] = [];
    while (this.position < buffer.length - 1) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      output.push(buffer[i] * (1 - frac) + buffer[i + 1] * frac);
      this.position += this.ratio;
    }
    this.position -= buffer.length - 1;
    this.previousSample = filtered[filtered.length - 1];
    return Float32Array.from(output);
  }

  private previousSample = 0;
}

/** Ring buffer holding the most recent `size` samples. */
export class RingBuffer {
  private readonly data: Float32Array;
  private writeIndex = 0;

  constructor(size: number) {
    this.data = new Float32Array(size);
  }

  push(samples: Float32Array) {
    const size = this.data.length;
    const toWrite =
      samples.length > size ? samples.subarray(samples.length - size) : samples;
    const firstPart = Math.min(toWrite.length, size - this.writeIndex);
    this.data.set(toWrite.subarray(0, firstPart), this.writeIndex);
    this.data.set(toWrite.subarray(firstPart), 0);
    this.writeIndex = (this.writeIndex + toWrite.length) % size;
  }

  /** @returns The buffer contents, oldest sample first. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.data.length);
    out.set(this.data.subarray(this.writeIndex));
    out.set(
      this.data.subarray(0, this.writeIndex),
      this.data.length - this.writeIndex,
    );
    return out;
  }

  clear() {
    this.data.fill(0);
    this.writeIndex = 0;
  }
}

export type InputKind = 'microphone' | 'test-melody';

/**
 * Captures audio from the microphone (or a synthesized test melody) and calls
 * `onAudio` with mono 22050Hz samples.
 */
export class AudioInput {
  private context?: AudioContext;
  private stream?: MediaStream;
  private resampler?: StreamResampler;
  private stopTestMelody?: () => void;
  /** counts the stops: a stop while the browser asks for the microphone ends that start */
  private stops = 0;

  constructor(
    private readonly onAudio: (samples: Float32Array) => void,
    private readonly keepMicrophone: () => boolean = () => false,
  ) {}

  get sampleRate(): number | undefined {
    return this.context?.sampleRate;
  }

  get isResampling(): boolean {
    return this.resampler !== undefined;
  }

  /**
   * @param port If given, the audio (mono, at the context's sample rate, see
   * `sampleRate`) goes to this port instead of `onAudio`.
   */
  async start(kind: InputKind, port?: MessagePort) {
    await this.stop();

    if (kind === 'microphone') {
      const stops = this.stops;
      const stream = await acquireMicrophone({
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
      if (stops !== this.stops) {
        stopMicrophone(stream);
        throw new DOMException('stopped while starting', 'AbortError');
      }
      this.stream = stream;
    }

    let context: AudioContext;
    let source: AudioNode;
    try {
      context = new AudioContext({ sampleRate: MODEL_SAMPLE_RATE });
      this.context = context;
      source = this.createSource(context, kind);
    } catch {
      // e.g. browsers that can't connect a microphone to a context with a different sample rate
      void this.context?.close();
      context = new AudioContext();
      source = this.createSource(context, kind);
    }
    this.context = context;
    this.resampler =
      context.sampleRate === MODEL_SAMPLE_RATE
        ? undefined
        : new StreamResampler(context.sampleRate, MODEL_SAMPLE_RATE);

    const workletUrl = URL.createObjectURL(
      new Blob([RECORDER_WORKLET], { type: 'application/javascript' }),
    );
    await context.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const recorder = new AudioWorkletNode(context, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    if (port) {
      recorder.port.postMessage({ port }, [port]);
      this.resampler = undefined;
    }
    recorder.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (port) return;
      this.onAudio(
        this.resampler ? this.resampler.process(event.data) : event.data,
      );
    };
    // the recorder has to be connected to the destination to be processed
    const mute = new GainNode(context, { gain: 0 });
    source.connect(recorder).connect(mute).connect(context.destination);
    await context.resume();
  }

  /** @param release the microphone is closed even if it should be kept */
  async stop(release = false) {
    this.stops++;
    this.stopTestMelody?.();
    this.stopTestMelody = undefined;
    if (this.stream) {
      if (release) {
        stopMicrophone(this.stream);
      } else {
        releaseMicrophone(this.stream, this.keepMicrophone);
      }
    }
    this.stream = undefined;
    await this.context?.close();
    this.context = undefined;
    this.resampler = undefined;
  }

  private createSource(context: AudioContext, kind: InputKind): AudioNode {
    if (kind === 'microphone') {
      return new MediaStreamAudioSourceNode(context, {
        mediaStream: this.stream!,
      });
    }
    const output = new GainNode(context, { gain: 1 });
    // also play the melody so you can hear what is being transcribed
    output.connect(context.destination);
    this.stopTestMelody = playTestMelody(context, output);
    return output;
  }
}

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Loop a short melody with chords (C major scale, then C - F - G - C) using
 * simple synthesized tones.
 * @returns A function stopping the melody.
 */
function playTestMelody(context: AudioContext, output: AudioNode): () => void {
  const scale = [60, 62, 64, 65, 67, 69, 71, 72].map(m => [m]);
  const chords = [
    [48, 60, 64, 67],
    [53, 57, 60, 65],
    [55, 59, 62, 67],
    [48, 60, 64, 72],
  ];
  const steps = [
    ...scale.map(notes => ({ notes, duration: 0.4 })),
    ...chords.map(notes => ({ notes, duration: 1 })),
  ];
  const loopDuration = steps.reduce((sum, s) => sum + s.duration + 0.1, 0);

  const scheduleLoop = (startTime: number) => {
    let t = startTime;
    steps.forEach(({ notes, duration }) => {
      notes.forEach(midi => {
        const osc = new OscillatorNode(context, {
          type: 'triangle',
          frequency: midiToHz(midi),
        });
        const env = new GainNode(context, { gain: 0 });
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(0.5 / notes.length, t + 0.01);
        env.gain.setTargetAtTime(0.25 / notes.length, t + 0.05, 0.2);
        env.gain.setTargetAtTime(0, t + duration, 0.03);
        osc.connect(env).connect(output);
        osc.start(t);
        osc.stop(t + duration + 0.3);
      });
      t += duration + 0.1;
    });
  };

  let nextLoop = context.currentTime + 0.1;
  scheduleLoop(nextLoop);
  const timer = setInterval(() => {
    if (context.currentTime > nextLoop + loopDuration - 1) {
      nextLoop += loopDuration;
      scheduleLoop(nextLoop);
    }
  }, 250);
  return () => clearInterval(timer);
}
