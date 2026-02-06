import {
  BASE_BPM,
  BPM_STEP,
  MAX_BPM,
  MIN_BPM,
  TRACKS,
  type TrackDefinition,
  type TrackId
} from '../config/tracks';
import type { AudioEngineState } from '../types/audio';

interface InternalTrackState {
  mute: boolean;
  solo: boolean;
  volume: number;
  baseVolume: number;
  effectiveGain: number;
}

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private mixGainNode: GainNode | null = null;
  private masterGainNode: GainNode | null = null;
  private stretchNode: AudioWorkletNode | null = null;

  private readonly buffers = new Map<TrackId, AudioBuffer>();
  private readonly trackGainNodes = new Map<TrackId, GainNode>();
  private readonly trackState = new Map<TrackId, InternalTrackState>();
  private readonly activeSources = new Map<TrackId, AudioBufferSourceNode>();

  private initialized = false;
  private loading = false;
  private playing = false;

  private bpm = BASE_BPM;
  private durationSec = 0;

  private startContextSec = 0;
  private startInputOffsetSec = 0;
  private pausedInputOffsetSec = 0;

  private playbackRunId = 0;
  private endedTrackIds = new Set<TrackId>();

  constructor(private readonly tracks: TrackDefinition[] = TRACKS) {
    for (const track of tracks) {
      this.trackState.set(track.id, {
        mute: false,
        solo: false,
        volume: 1,
        baseVolume: track.initialVolume,
        effectiveGain: track.initialVolume
      });
    }
  }

  getState(): AudioEngineState {
    return {
      initialized: this.initialized,
      loading: this.loading,
      playing: this.playing,
      bpm: this.bpm,
      tempoRatio: this.getTempoRatio(),
      currentInputSec: this.getCurrentInputSec(),
      durationSec: this.durationSec,
      tracks: this.tracks.map((track) => {
        const state = this.trackState.get(track.id)!;
        return {
          ...track,
          mute: state.mute,
          solo: state.solo,
          volume: state.volume,
          effectiveGain: state.effectiveGain
        };
      })
    };
  }

  async init(): Promise<void> {
    if (this.initialized || this.loading) {
      return;
    }

    this.loading = true;

    try {
      this.audioCtx = new AudioContext();
      await this.audioCtx.audioWorklet.addModule('/worklets/soundtouch-worklet.js');

      this.mixGainNode = this.audioCtx.createGain();
      this.masterGainNode = this.audioCtx.createGain();
      this.masterGainNode.gain.value = 0.8;

      this.stretchNode = new AudioWorkletNode(this.audioCtx, 'soundtouch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        parameterData: {
          tempo: this.getTempoRatio(),
          pitch: 1
        }
      });

      this.mixGainNode.connect(this.stretchNode);
      this.stretchNode.connect(this.masterGainNode);
      this.masterGainNode.connect(this.audioCtx.destination);

      for (const track of this.tracks) {
        const gainNode = this.audioCtx.createGain();
        gainNode.connect(this.mixGainNode);
        this.trackGainNodes.set(track.id, gainNode);
      }

      this.applyTrackMix();
      await this.loadTrackBuffers();

      this.initialized = true;
    } catch (error) {
      this.disposeNodes();
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async play(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }

    if (!this.audioCtx) {
      throw new Error('AudioContext is not ready.');
    }

    if (this.loading || this.playing) {
      return;
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    const offsetSec = this.clampInputOffset(this.pausedInputOffsetSec);
    if (this.durationSec > 0 && offsetSec >= this.durationSec) {
      this.pausedInputOffsetSec = 0;
      this.startInputOffsetSec = 0;
    }

    const resolvedOffset = this.clampInputOffset(this.pausedInputOffsetSec);
    this.stopCurrentSources();

    const runId = ++this.playbackRunId;
    this.endedTrackIds = new Set<TrackId>();

    for (const track of this.tracks) {
      const buffer = this.buffers.get(track.id);
      const trackGainNode = this.trackGainNodes.get(track.id);
      if (!buffer || !trackGainNode) {
        continue;
      }

      if (resolvedOffset >= buffer.duration) {
        this.endedTrackIds.add(track.id);
        continue;
      }

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(trackGainNode);
      source.onended = () => {
        this.activeSources.delete(track.id);

        if (runId !== this.playbackRunId || !this.playing) {
          return;
        }

        this.endedTrackIds.add(track.id);
        if (this.endedTrackIds.size === this.tracks.length) {
          this.playing = false;
          this.startInputOffsetSec = 0;
          this.pausedInputOffsetSec = 0;
        }
      };

      source.start(0, resolvedOffset);
      this.activeSources.set(track.id, source);
    }

    if (this.activeSources.size === 0) {
      this.playing = false;
      this.pausedInputOffsetSec = 0;
      this.startInputOffsetSec = 0;
      return;
    }

    this.setTempoParameters();

    this.startContextSec = this.audioCtx.currentTime;
    this.startInputOffsetSec = resolvedOffset;
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) {
      return;
    }

    const currentInputSec = this.getCurrentInputSec();
    this.stopCurrentSources();

    this.playing = false;
    this.pausedInputOffsetSec = this.clampInputOffset(currentInputSec);
    this.startInputOffsetSec = this.pausedInputOffsetSec;
  }

  stop(): void {
    this.stopCurrentSources();

    this.playing = false;
    this.pausedInputOffsetSec = 0;
    this.startInputOffsetSec = 0;
  }

  async setBpm(nextBpm: number): Promise<void> {
    const normalized = this.normalizeBpm(nextBpm);
    if (normalized === this.bpm) {
      return;
    }

    const wasPlaying = this.playing;
    let resumeOffset = this.pausedInputOffsetSec;

    if (wasPlaying) {
      resumeOffset = this.getCurrentInputSec();
      this.stopCurrentSources();
      this.playing = false;
      this.pausedInputOffsetSec = this.clampInputOffset(resumeOffset);
      this.startInputOffsetSec = this.pausedInputOffsetSec;
    }

    this.bpm = normalized;
    this.setTempoParameters();

    if (wasPlaying) {
      await this.play();
    }
  }

  async changeBpm(delta: number): Promise<void> {
    await this.setBpm(this.bpm + delta);
  }

  async resetBpm(): Promise<void> {
    await this.setBpm(BASE_BPM);
  }

  toggleMute(trackId: TrackId): void {
    const state = this.trackState.get(trackId);
    if (!state) {
      return;
    }

    state.mute = !state.mute;
    this.applyTrackMix();
  }

  toggleSolo(trackId: TrackId): void {
    const state = this.trackState.get(trackId);
    if (!state) {
      return;
    }

    state.solo = !state.solo;
    this.applyTrackMix();
  }

  setVolume(trackId: TrackId, volume: number): void {
    const state = this.trackState.get(trackId);
    if (!state) {
      return;
    }

    state.volume = this.clamp(volume, 0, 1);
    this.applyTrackMix();
  }

  private async loadTrackBuffers(): Promise<void> {
    if (!this.audioCtx) {
      throw new Error('AudioContext is not available.');
    }

    const loaded = await Promise.all(
      this.tracks.map(async (track) => {
        const response = await fetch(track.url);
        if (!response.ok) {
          throw new Error(`Failed to load audio: ${track.url}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const decoded = await this.audioCtx!.decodeAudioData(arrayBuffer.slice(0));
        return [track.id, decoded] as const;
      })
    );

    for (const [id, buffer] of loaded) {
      this.buffers.set(id, buffer);
    }

    this.durationSec = loaded.reduce((max, [, buffer]) => Math.max(max, buffer.duration), 0);
  }

  private applyTrackMix(): void {
    const hasSolo = Array.from(this.trackState.values()).some((state) => state.solo);
    const now = this.audioCtx?.currentTime ?? 0;

    for (const track of this.tracks) {
      const state = this.trackState.get(track.id);
      if (!state) {
        continue;
      }

      const audibleBySolo = !hasSolo || state.solo;
      const audible = audibleBySolo && !state.mute;
      const effectiveGain = audible ? state.baseVolume * state.volume : 0;

      state.effectiveGain = effectiveGain;

      const gainNode = this.trackGainNodes.get(track.id);
      if (gainNode) {
        gainNode.gain.setTargetAtTime(effectiveGain, now, 0.01);
      }
    }
  }

  private setTempoParameters(): void {
    if (!this.stretchNode || !this.audioCtx) {
      return;
    }

    const tempoParam = this.stretchNode.parameters.get('tempo');
    const pitchParam = this.stretchNode.parameters.get('pitch');

    if (tempoParam) {
      tempoParam.setValueAtTime(this.getTempoRatio(), this.audioCtx.currentTime);
    }

    if (pitchParam) {
      pitchParam.setValueAtTime(1, this.audioCtx.currentTime);
    }
  }

  private getTempoRatio(): number {
    return this.bpm / BASE_BPM;
  }

  private getCurrentInputSec(): number {
    if (!this.playing || !this.audioCtx) {
      return this.clampInputOffset(this.pausedInputOffsetSec);
    }

    const outputElapsedSec = Math.max(0, this.audioCtx.currentTime - this.startContextSec);
    const inputProgressSec = outputElapsedSec * this.getTempoRatio();

    return this.clampInputOffset(this.startInputOffsetSec + inputProgressSec);
  }

  private stopCurrentSources(): void {
    this.playbackRunId += 1;
    this.endedTrackIds.clear();

    for (const source of this.activeSources.values()) {
      source.onended = null;

      try {
        source.stop();
      } catch {
        // no-op: source may have already ended
      }

      source.disconnect();
    }

    this.activeSources.clear();
  }

  private normalizeBpm(value: number): number {
    const clamped = this.clamp(value, MIN_BPM, MAX_BPM);
    const stepped = Math.round(clamped / BPM_STEP) * BPM_STEP;
    return this.clamp(stepped, MIN_BPM, MAX_BPM);
  }

  private clampInputOffset(value: number): number {
    if (this.durationSec <= 0) {
      return 0;
    }

    return this.clamp(value, 0, this.durationSec);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private disposeNodes(): void {
    this.stopCurrentSources();

    for (const gainNode of this.trackGainNodes.values()) {
      gainNode.disconnect();
    }
    this.trackGainNodes.clear();

    this.stretchNode?.disconnect();
    this.masterGainNode?.disconnect();
    this.mixGainNode?.disconnect();

    this.stretchNode = null;
    this.masterGainNode = null;
    this.mixGainNode = null;

    if (this.audioCtx) {
      void this.audioCtx.close();
    }
    this.audioCtx = null;

    this.buffers.clear();

    this.initialized = false;
    this.loading = false;
    this.playing = false;
    this.durationSec = 0;
    this.startContextSec = 0;
    this.startInputOffsetSec = 0;
    this.pausedInputOffsetSec = 0;
  }
}

export const createAudioEngine = (): AudioEngine => new AudioEngine();
