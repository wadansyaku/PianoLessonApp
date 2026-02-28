import {
  DEFAULT_AUDIO_PATTERN_ID,
  BASE_BPM,
  BPM_STEP,
  MAX_BPM,
  MIN_BPM,
  TRACKS,
  getAudioPattern,
  type AudioPatternDefinition,
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

interface BeatPoint {
  timeSec: number;
  strength: number;
  brightness: number;
}

type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext;

interface WindowWithWebkitAudio extends Window {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: {
    type?: string;
  };
}

const MASTER_GAIN_TARGET = 0.55;
const BPM_TRANSITION_SEC = 0.08;
const AUDIO_ARRAY_BUFFER_CACHE = new Map<string, Promise<ArrayBuffer>>();

const resolveAudioContextCtor = (): AudioContextCtor | null => {
  const win = window as WindowWithWebkitAudio;
  return win.AudioContext ?? win.webkitAudioContext ?? null;
};

export class AudioEngine {
  private readonly tracks: TrackDefinition[];
  private readonly displayScoreBars: number[];
  private readonly twoBeatBarIndexes = new Set<number>();
  private readonly tempoHintByBarIndex = new Map<number, number>();

  private audioCtx: AudioContext | null = null;
  private mixGainNode: GainNode | null = null;
  private postFilterNode: BiquadFilterNode | null = null;
  private masterGainNode: GainNode | null = null;
  private stretchNode: AudioWorkletNode | null = null;
  private workletEnabled = false;

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

  private barStartSec: number[] = [0];
  private selectedStartBar = 0;

  constructor(pattern: AudioPatternDefinition = getAudioPattern(DEFAULT_AUDIO_PATTERN_ID)) {
    this.tracks = pattern.tracks.length > 0 ? pattern.tracks : TRACKS;
    this.displayScoreBars = pattern.displayBars.length > 0 ? [...pattern.displayBars] : [0];

    for (const displayBar of pattern.twoBeatDisplayBars) {
      const index = this.displayScoreBars.indexOf(displayBar);
      if (index >= 0) {
        this.twoBeatBarIndexes.add(index);
      }
    }

    if (pattern.tempoHintsByDisplayBar) {
      for (const [displayBar, bpm] of Object.entries(pattern.tempoHintsByDisplayBar)) {
        const numericDisplayBar = Number(displayBar);
        if (!Number.isFinite(numericDisplayBar) || typeof bpm !== 'number' || !Number.isFinite(bpm)) {
          continue;
        }

        const index = this.displayScoreBars.indexOf(numericDisplayBar);
        if (index >= 0) {
          this.tempoHintByBarIndex.set(index, bpm);
        }
      }
    }

    for (const track of this.tracks) {
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
    const currentInputSec = this.getCurrentInputSec();
    const maxBarIndex = this.getMaxBar();
    const currentBarIndex = this.findBarByInputSec(currentInputSec);
    const selectedStartBarIndex = this.clampBarNumber(this.selectedStartBar);
    const selectableBars = this.displayScoreBars.slice(0, maxBarIndex + 1);

    return {
      initialized: this.initialized,
      loading: this.loading,
      playing: this.playing,
      bpm: this.bpm,
      currentInputSec,
      durationSec: this.durationSec,
      currentBar: this.getDisplayBarByIndex(currentBarIndex),
      selectedStartBar: this.getDisplayBarByIndex(selectedStartBarIndex),
      selectedStartSec: this.getBarStartSec(selectedStartBarIndex),
      maxBar: selectableBars[selectableBars.length - 1] ?? 0,
      selectableBars,
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
      const AudioContextClass = resolveAudioContextCtor();
      if (!AudioContextClass) {
        throw new Error(
          'このブラウザでは音声の再生機能に対応していません。SafariかChromeで開いてください。'
        );
      }

      this.audioCtx = new AudioContextClass();
      this.configureMobileAudioPolicy();

      this.mixGainNode = this.audioCtx.createGain();
      this.postFilterNode = this.audioCtx.createBiquadFilter();
      this.postFilterNode.type = 'lowpass';
      this.postFilterNode.frequency.value = 14000;
      this.postFilterNode.Q.value = 0.65;
      this.masterGainNode = this.audioCtx.createGain();
      this.masterGainNode.gain.value = MASTER_GAIN_TARGET;

      this.workletEnabled = await this.setupStretchWorklet();
      if (this.workletEnabled && this.stretchNode) {
        this.mixGainNode.connect(this.stretchNode);
        this.stretchNode.connect(this.postFilterNode);
      } else {
        // Fallback: keep app usable even on browsers without AudioWorklet.
        this.mixGainNode.connect(this.postFilterNode);
      }

      this.postFilterNode.connect(this.masterGainNode);
      this.masterGainNode.connect(this.audioCtx.destination);

      for (const track of this.tracks) {
        const gainNode = this.audioCtx.createGain();
        gainNode.connect(this.mixGainNode);
        this.trackGainNodes.set(track.id, gainNode);
      }

      this.applyTrackMix();
      await this.loadTrackBuffers();
      this.buildBarMapFromClick();

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

    this.configureMobileAudioPolicy();

    const offsetSec = this.clampInputOffset(this.pausedInputOffsetSec);
    const resolvedOffset =
      this.durationSec > 0 && offsetSec >= this.durationSec
        ? this.getBarStartSec(this.selectedStartBar)
        : offsetSec;

    this.stopCurrentSources();
    this.startSourcesAtOffset(resolvedOffset, {
      scheduledStartSec: this.audioCtx.currentTime + 0.004,
      fadeIn: true
    });
  }

  pause(): void {
    if (!this.playing || !this.audioCtx) {
      return;
    }

    const currentInputSec = this.getCurrentInputSec();

    if (this.masterGainNode) {
      const now = this.audioCtx.currentTime;
      this.masterGainNode.gain.cancelScheduledValues(now);
      this.masterGainNode.gain.setValueAtTime(0.0001, now);
    }

    this.stopCurrentSources();

    this.playing = false;
    this.pausedInputOffsetSec = this.clampInputOffset(currentInputSec);
    this.startInputOffsetSec = this.pausedInputOffsetSec;
    this.selectedStartBar = this.findBarByInputSec(this.pausedInputOffsetSec);
  }

  stop(): void {
    this.stopCurrentSources();

    this.playing = false;
    this.selectedStartBar = 0;
    this.pausedInputOffsetSec = this.getBarStartSec(0);
    this.startInputOffsetSec = this.pausedInputOffsetSec;

    if (this.audioCtx && this.masterGainNode) {
      const now = this.audioCtx.currentTime;
      this.masterGainNode.gain.cancelScheduledValues(now);
      this.masterGainNode.gain.setValueAtTime(MASTER_GAIN_TARGET, now);
    }
  }

  destroy(): void {
    this.disposeNodes();
  }

  async setBpm(nextBpm: number): Promise<void> {
    const normalized = this.normalizeBpm(nextBpm);
    if (normalized === this.bpm) {
      return;
    }

    if (this.playing && this.audioCtx) {
      const currentInputSec = this.getCurrentInputSec();
      this.startContextSec = this.audioCtx.currentTime;
      this.startInputOffsetSec = this.clampInputOffset(currentInputSec);
      this.pausedInputOffsetSec = this.startInputOffsetSec;
      this.selectedStartBar = this.findBarByInputSec(this.startInputOffsetSec);
    }

    this.bpm = normalized;
    const transitionSec = this.playing ? BPM_TRANSITION_SEC : 0;
    this.setTempoParameters(transitionSec);
    this.setActiveSourcePlaybackRate(transitionSec);
  }

  async changeBpm(delta: number): Promise<void> {
    await this.setBpm(this.bpm + delta);
  }

  async resetBpm(): Promise<void> {
    await this.setBpm(BASE_BPM);
  }

  async setStartBar(bar: number): Promise<void> {
    const normalizedBar = this.findNearestBarIndexByDisplayBar(Math.round(bar));
    this.selectedStartBar = normalizedBar;

    const nextOffset = this.getBarStartSec(normalizedBar);
    this.pausedInputOffsetSec = nextOffset;
    this.startInputOffsetSec = nextOffset;

    if (this.playing && this.audioCtx) {
      await this.fadeMasterOut(0.01);
      this.stopCurrentSources();
      this.playing = false;
      this.startSourcesAtOffset(nextOffset, {
        scheduledStartSec: this.audioCtx.currentTime + 0.005,
        fadeIn: true
      });
    }
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
        const decoded = await this.fetchTrackBufferWithRetry(track);
        return [track.id, decoded] as const;
      })
    );

    for (const [id, buffer] of loaded) {
      this.buffers.set(id, buffer);
    }

    this.durationSec = loaded.reduce((max, [, buffer]) => Math.max(max, buffer.duration), 0);
  }

  private async fetchTrackBufferWithRetry(track: TrackDefinition): Promise<AudioBuffer> {
    if (!this.audioCtx) {
      throw new Error('AudioContext is not available.');
    }

    const baseCandidates = this.buildAudioUrlCandidates(track.url);
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const candidate of baseCandidates) {
        const url =
          attempt === 0
            ? candidate
            : this.withCacheBust(candidate, `retry-${attempt}-${Date.now().toString(36)}`);
        try {
          return await this.fetchAndDecodeAudio(url, attempt === 0);
        } catch (error) {
          lastError = error;
        }
      }

      await this.sleep(120 * (attempt + 1));
    }

    if (lastError instanceof Error) {
      throw new Error(`Failed to load audio: ${track.url} (${lastError.message})`);
    }
    throw new Error(`Failed to load audio: ${track.url}`);
  }

  private buildAudioUrlCandidates(url: string): string[] {
    const candidates = new Set<string>();
    candidates.add(url);

    const noQuery = url.split('?')[0];
    if (noQuery) {
      candidates.add(noQuery);
    }

    return Array.from(candidates);
  }

  private withCacheBust(url: string, token: string): string {
    return url.includes('?') ? `${url}&cb=${token}` : `${url}?cb=${token}`;
  }

  private async getCachedArrayBuffer(url: string): Promise<ArrayBuffer> {
    const cached = AUDIO_ARRAY_BUFFER_CACHE.get(url);
    if (cached) {
      const arrayBuffer = await cached;
      return arrayBuffer.slice(0);
    }

    const loading = fetch(url, { cache: 'force-cache' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`status=${response.status}`);
        }
        return response.arrayBuffer();
      })
      .catch((error) => {
        AUDIO_ARRAY_BUFFER_CACHE.delete(url);
        throw error;
      });

    AUDIO_ARRAY_BUFFER_CACHE.set(url, loading);
    const arrayBuffer = await loading;
    return arrayBuffer.slice(0);
  }

  private async fetchAndDecodeAudio(url: string, useCache: boolean): Promise<AudioBuffer> {
    if (!this.audioCtx) {
      throw new Error('AudioContext is not available.');
    }

    let arrayBuffer: ArrayBuffer;

    if (useCache) {
      arrayBuffer = await this.getCachedArrayBuffer(url);
    } else {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`status=${response.status}`);
      }
      arrayBuffer = await response.arrayBuffer();
    }

    return this.audioCtx.decodeAudioData(arrayBuffer.slice(0));
  }

  private buildBarMapFromClick(): void {
    const clickBuffer = this.buffers.get('click');
    const targetBarCount = this.displayScoreBars.length;

    if (!clickBuffer) {
      this.barStartSec = [0];
      this.selectedStartBar = 0;
      return;
    }

    const beats = this.detectBeatPoints(clickBuffer);
    const beatTimes = beats.map((beat) => beat.timeSec);

    const minBeatCount = Math.max(24, targetBarCount * 2);
    if (beatTimes.length < minBeatCount) {
      this.barStartSec = this.buildFallbackBarStarts(clickBuffer.duration, targetBarCount);
      this.selectedStartBar = this.clampBarNumber(this.selectedStartBar);
      return;
    }

    const starts = this.deriveBarStartsFromBeats(beats, clickBuffer.duration, targetBarCount);
    this.barStartSec =
      starts.length > 0 ? starts : this.buildFallbackBarStarts(clickBuffer.duration, targetBarCount);
    this.selectedStartBar = this.clampBarNumber(this.selectedStartBar);
  }

  private detectBeatPoints(buffer: AudioBuffer): BeatPoint[] {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    const hop = 256;
    const windowSec = 0.015;

    const length = buffer.length;
    const frameCount = Math.floor(length / hop);

    if (frameCount <= 0) {
      return [];
    }

    const envelope = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const base = frame * hop;
      let sum = 0;

      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel);

        for (let i = 0; i < hop; i += 1) {
          sum += Math.abs(data[base + i] ?? 0);
        }
      }

      envelope[frame] = sum / (hop * channels);
    }

    const smooth = new Float32Array(frameCount);
    let prev = envelope[0];
    const alpha = 0.28;

    for (let i = 0; i < frameCount; i += 1) {
      prev = alpha * envelope[i] + (1 - alpha) * prev;
      smooth[i] = prev;
    }

    const onset = new Float32Array(frameCount);
    for (let i = 1; i < frameCount; i += 1) {
      onset[i] = Math.max(0, smooth[i] - smooth[i - 1]);
    }

    const values = Array.from(onset).sort((a, b) => a - b);
    const p90 = values[Math.floor(values.length * 0.9)] ?? 0;
    const p99 = values[Math.floor(values.length * 0.99)] ?? p90;
    const threshold = p90 + (p99 - p90) * 0.24;

    const minGapSec = 0.22;
    const minGapFrames = Math.max(1, Math.floor((sampleRate * minGapSec) / hop));

    const peaks: number[] = [];

    for (let i = 1; i < onset.length - 1; i += 1) {
      if (onset[i] < threshold || onset[i] < onset[i - 1] || onset[i] < onset[i + 1]) {
        continue;
      }

      const last = peaks[peaks.length - 1];
      if (last !== undefined && i - last < minGapFrames) {
        if (onset[i] > onset[last]) {
          peaks[peaks.length - 1] = i;
        }
        continue;
      }

      peaks.push(i);
    }

    const beats: BeatPoint[] = [];
    const radius = Math.max(1, Math.floor(windowSec * sampleRate));

    for (const frame of peaks) {
      const center = frame * hop;
      const start = Math.max(0, center - radius);
      const end = Math.min(length - 1, center + radius);

      let absSum = 0;
      let diffSum = 0;
      let count = 0;

      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel);

        for (let i = start + 1; i <= end; i += 1) {
          const value = data[i] ?? 0;
          const prevValue = data[i - 1] ?? 0;
          absSum += Math.abs(value);
          diffSum += Math.abs(value - prevValue);
          count += 1;
        }
      }

      if (count === 0) {
        continue;
      }

      beats.push({
        timeSec: center / sampleRate,
        strength: onset[frame],
        brightness: diffSum / (absSum + 1e-6)
      });
    }

    if (beats.length === 0 || beats[0].timeSec > 0.05) {
      beats.unshift({
        timeSec: 0,
        strength: 0,
        brightness: 0
      });
    } else {
      beats[0].timeSec = 0;
    }

    return beats;
  }

  private deriveBarStartsFromBeats(
    beats: BeatPoint[],
    durationSec: number,
    targetBarCount: number
  ): number[] {
    const beatTimes = beats.map((beat) => beat.timeSec);
    const beatStrength = this.normalize(beats.map((beat) => beat.strength));
    const beatBrightness = this.normalize(beats.map((beat) => beat.brightness));

    const startScore = beatStrength.map((value, index) => value * 0.72 + beatBrightness[index] * 0.28);

    const intervals: number[] = [];
    for (let i = 1; i < beatTimes.length; i += 1) {
      const delta = beatTimes[i] - beatTimes[i - 1];
      if (delta > 0.2 && delta < 1.6) {
        intervals.push(delta);
      }
    }

    const medianBeatSec = this.median(intervals) ?? 60 / BASE_BPM;

    const beatCount = beatTimes.length;
    const maxPossibleBars = Math.floor((beatCount - 1) / 2) + 1;
    const fittedBarCount = Math.min(targetBarCount, Math.max(2, maxPossibleBars));

    const impossible = -1e9;
    const dp = Array.from({ length: fittedBarCount }, () => new Float64Array(beatCount).fill(impossible));
    const prev = Array.from({ length: fittedBarCount }, () => new Int32Array(beatCount).fill(-1));

    dp[0][0] = 0;

    for (let bar = 0; bar < fittedBarCount - 1; bar += 1) {
      for (let currentBeat = 0; currentBeat < beatCount; currentBeat += 1) {
        const currentScore = dp[bar][currentBeat];
        if (currentScore <= impossible / 2) {
          continue;
        }

        const preferredBeatCount = this.getBarBeatCount(bar);
        const stepCandidates = preferredBeatCount === 2 ? [2, 4] : [4, 2];

        for (const step of stepCandidates) {
          const nextBeat = currentBeat + step;
          if (nextBeat >= beatCount) {
            continue;
          }

          const barDurationSec = beatTimes[nextBeat] - beatTimes[currentBeat];
          const expectedSec = this.getExpectedBarDurationSec(bar, step, medianBeatSec);
          const durationPenalty = -Math.abs(barDurationSec - expectedSec) / Math.max(expectedSec * 0.45, 0.12);
          const meterPenalty = step === preferredBeatCount ? 0 : -1.4;
          const score = currentScore + startScore[nextBeat] + durationPenalty + meterPenalty;

          if (score > dp[bar + 1][nextBeat]) {
            dp[bar + 1][nextBeat] = score;
            prev[bar + 1][nextBeat] = currentBeat;
          }
        }
      }
    }

    const lastBar = fittedBarCount - 1;
    let bestEndBeat = -1;
    let bestScore = impossible;

    for (let beatIndex = 0; beatIndex < beatCount; beatIndex += 1) {
      const remainingBeats = (beatCount - 1) - beatIndex;
      const terminalPenalty = -Math.abs(remainingBeats - 4) * 0.045;
      const score = dp[lastBar][beatIndex] + terminalPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestEndBeat = beatIndex;
      }
    }

    if (bestEndBeat < 0) {
      return this.buildFallbackBarStarts(durationSec, targetBarCount);
    }

    const beatIndexStarts = new Array<number>(fittedBarCount).fill(0);
    beatIndexStarts[lastBar] = bestEndBeat;

    for (let bar = lastBar; bar > 0; bar -= 1) {
      const previous = prev[bar][beatIndexStarts[bar]];
      if (previous < 0) {
        return this.buildFallbackBarStarts(durationSec, targetBarCount);
      }
      beatIndexStarts[bar - 1] = previous;
    }

    const starts = beatIndexStarts.map((index) => beatTimes[index]);
    starts[0] = 0;

    const deduped: number[] = [];
    for (const value of starts) {
      if (deduped.length === 0 || value - deduped[deduped.length - 1] > 0.08) {
        deduped.push(value);
      }
    }

    const fallbackBarSec = medianBeatSec * 4;
    while (deduped.length < targetBarCount) {
      const last = deduped[deduped.length - 1] ?? 0;
      const next = Math.min(durationSec, last + fallbackBarSec);
      if (next <= last + 0.05) {
        break;
      }
      deduped.push(next);
    }

    if (deduped.length > targetBarCount) {
      deduped.length = targetBarCount;
    }

    return deduped;
  }

  private buildFallbackBarStarts(durationSec: number, targetBarCount: number): number[] {
    const bars: number[] = [];
    let cursorSec = 0;

    for (let bar = 0; bar < targetBarCount; bar += 1) {
      const sec = Math.min(durationSec, cursorSec);
      if (bars.length === 0 || sec - bars[bars.length - 1] > 0.04) {
        bars.push(sec);
      }

      cursorSec += this.getExpectedBarDurationSec(bar, this.getBarBeatCount(bar), 60 / BASE_BPM);
    }

    return bars.length > 0 ? bars : [0];
  }

  private startSourcesAtOffset(
    offsetSec: number,
    options: {
      scheduledStartSec: number;
      fadeIn: boolean;
    }
  ): void {
    if (!this.audioCtx) {
      return;
    }

    const resolvedOffset = this.clampInputOffset(offsetSec);
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
      source.playbackRate.setValueAtTime(this.getTempoRatio(), options.scheduledStartSec);
      source.connect(trackGainNode);
      source.onended = () => {
        this.activeSources.delete(track.id);

        if (runId !== this.playbackRunId || !this.playing) {
          return;
        }

        this.endedTrackIds.add(track.id);
        if (this.endedTrackIds.size === this.tracks.length) {
          this.playing = false;
          this.selectedStartBar = 0;
          this.startInputOffsetSec = this.getBarStartSec(0);
          this.pausedInputOffsetSec = this.startInputOffsetSec;
        }
      };

      source.start(options.scheduledStartSec, resolvedOffset);
      this.activeSources.set(track.id, source);
    }

    if (this.activeSources.size === 0) {
      this.playing = false;
      this.selectedStartBar = 0;
      this.pausedInputOffsetSec = this.getBarStartSec(0);
      this.startInputOffsetSec = this.pausedInputOffsetSec;
      return;
    }

    this.setTempoParameters();

    if (this.masterGainNode) {
      const now = this.audioCtx.currentTime;
      const gain = this.masterGainNode.gain;
      gain.cancelScheduledValues(now);

      if (options.fadeIn) {
        gain.setValueAtTime(0.0001, now);
        gain.linearRampToValueAtTime(MASTER_GAIN_TARGET, options.scheduledStartSec + 0.02);
      } else {
        gain.setValueAtTime(MASTER_GAIN_TARGET, now);
      }
    }

    this.startContextSec = options.scheduledStartSec;
    this.startInputOffsetSec = resolvedOffset;
    this.pausedInputOffsetSec = resolvedOffset;
    this.selectedStartBar = this.findBarByInputSec(resolvedOffset);
    this.playing = true;
  }

  private async fadeMasterOut(durationSec: number): Promise<void> {
    if (!this.audioCtx || !this.masterGainNode) {
      return;
    }

    const now = this.audioCtx.currentTime;
    const gain = this.masterGainNode.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0.0001, now + durationSec);

    await this.sleep((durationSec * 1000) + 2);
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

  private setTempoParameters(transitionSec = 0): void {
    if (!this.workletEnabled || !this.stretchNode || !this.audioCtx) {
      return;
    }

    const rateParam = this.stretchNode.parameters.get('rate');
    const tempoParam = this.stretchNode.parameters.get('tempo');
    const pitchParam = this.stretchNode.parameters.get('pitch');
    const now = this.audioCtx.currentTime;
    const targetPitch = 1 / this.getTempoRatio();

    if (rateParam) {
      rateParam.cancelScheduledValues(now);
      rateParam.setValueAtTime(1, now);
    }

    if (tempoParam) {
      tempoParam.cancelScheduledValues(now);
      tempoParam.setValueAtTime(1, now);
    }

    if (pitchParam) {
      pitchParam.cancelScheduledValues(now);
      pitchParam.setValueAtTime(pitchParam.value, now);

      if (transitionSec > 0) {
        pitchParam.linearRampToValueAtTime(targetPitch, now + transitionSec);
      } else {
        pitchParam.setValueAtTime(targetPitch, now);
      }
    }
  }

  private setActiveSourcePlaybackRate(transitionSec = 0): void {
    if (!this.audioCtx) {
      return;
    }

    const now = this.audioCtx.currentTime;
    const targetRate = this.getTempoRatio();

    for (const source of this.activeSources.values()) {
      const rateParam = source.playbackRate;
      rateParam.cancelScheduledValues(now);
      rateParam.setValueAtTime(rateParam.value, now);

      if (transitionSec > 0) {
        rateParam.linearRampToValueAtTime(targetRate, now + transitionSec);
      } else {
        rateParam.setValueAtTime(targetRate, now);
      }
    }
  }

  private getBarBeatCount(barIndex: number): number {
    return this.twoBeatBarIndexes.has(barIndex) ? 2 : 4;
  }

  private getExpectedBarDurationSec(barIndex: number, beatCount: number, fallbackBeatSec: number): number {
    const hintBpm = this.tempoHintByBarIndex.get(barIndex);
    if (hintBpm && hintBpm > 0) {
      return (60 / hintBpm) * beatCount;
    }

    return fallbackBeatSec * beatCount;
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

  private findBarByInputSec(inputSec: number): number {
    if (this.barStartSec.length <= 1) {
      return 0;
    }

    let low = 0;
    let high = this.barStartSec.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const value = this.barStartSec[mid];

      if (value <= inputSec) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return this.clampBarNumber(high);
  }

  private getBarStartSec(bar: number): number {
    const normalizedBar = this.clampBarNumber(bar);
    return this.barStartSec[normalizedBar] ?? 0;
  }

  private getDisplayBarByIndex(index: number): number {
    const normalizedBar = this.clampBarNumber(index);
    return this.displayScoreBars[normalizedBar] ?? 0;
  }

  private findNearestBarIndexByDisplayBar(displayBar: number): number {
    if (this.displayScoreBars.length === 0) {
      return 0;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < this.displayScoreBars.length; index += 1) {
      const distance = Math.abs(this.displayScoreBars[index] - displayBar);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return this.clampBarNumber(bestIndex);
  }

  private getMaxBar(): number {
    const maxPatternIndex = Math.max(0, this.displayScoreBars.length - 1);
    return this.clamp(
      Math.min(maxPatternIndex, this.barStartSec.length - 1),
      0,
      maxPatternIndex
    );
  }

  private clampBarNumber(bar: number): number {
    return this.clamp(bar, 0, this.getMaxBar());
  }

  private stopCurrentSources(): void {
    this.playbackRunId += 1;
    this.endedTrackIds.clear();

    for (const source of this.activeSources.values()) {
      source.onended = null;

      try {
        source.stop();
      } catch {
        // no-op: source may already have ended
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

  private median(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return sorted[mid];
  }

  private normalize(values: number[]): number[] {
    if (values.length === 0) {
      return [];
    }

    const min = Math.min(...values);
    const max = Math.max(...values);

    if (Math.abs(max - min) < 1e-9) {
      return values.map(() => 0);
    }

    return values.map((value) => (value - min) / (max - min));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  private disposeNodes(): void {
    this.stopCurrentSources();

    for (const gainNode of this.trackGainNodes.values()) {
      gainNode.disconnect();
    }
    this.trackGainNodes.clear();

    this.stretchNode?.disconnect();
    this.postFilterNode?.disconnect();
    this.masterGainNode?.disconnect();
    this.mixGainNode?.disconnect();

    this.stretchNode = null;
    this.workletEnabled = false;
    this.postFilterNode = null;
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
    this.barStartSec = [0];
    this.selectedStartBar = 0;
  }

  private async setupStretchWorklet(): Promise<boolean> {
    if (!this.audioCtx) {
      return false;
    }

    const hasWorkletApi =
      !!this.audioCtx.audioWorklet &&
      typeof this.audioCtx.audioWorklet.addModule === 'function' &&
      typeof AudioWorkletNode !== 'undefined';

    if (!hasWorkletApi) {
      return false;
    }

    try {
      await this.audioCtx.audioWorklet.addModule('/worklets/soundtouch-worklet.js');
      this.stretchNode = new AudioWorkletNode(this.audioCtx, 'soundtouch-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        parameterData: {
          rate: 1,
          tempo: 1,
          pitch: 1 / this.getTempoRatio()
        }
      });
      return true;
    } catch {
      this.stretchNode = null;
      return false;
    }
  }

  private configureMobileAudioPolicy(): void {
    const nav = navigator as NavigatorWithAudioSession;
    try {
      if (nav.audioSession) {
        nav.audioSession.type = 'playback';
      }
    } catch {
      // no-op
    }

    if ('mediaSession' in navigator && navigator.mediaSession) {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '練習プレイヤー',
          artist: 'PianoLessonApp'
        });
      }

      try {
        navigator.mediaSession.setActionHandler('play', () => {
          void this.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          this.pause();
        });
        navigator.mediaSession.setActionHandler('stop', () => {
          this.stop();
        });
      } catch {
        // no-op
      }
    }
  }
}

export const createAudioEngine = (pattern?: AudioPatternDefinition): AudioEngine =>
  new AudioEngine(pattern);
