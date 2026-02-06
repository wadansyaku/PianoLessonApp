import type { TrackDefinition, TrackId } from '../config/tracks';

export interface TrackMixState {
  id: TrackId;
  mute: boolean;
  solo: boolean;
  volume: number;
  effectiveGain: number;
}

export interface TrackRuntimeState extends TrackDefinition, TrackMixState {}

export interface AudioEngineState {
  initialized: boolean;
  loading: boolean;
  playing: boolean;
  bpm: number;
  currentInputSec: number;
  durationSec: number;
  currentBar: number;
  selectedStartBar: number;
  selectedStartSec: number;
  maxBar: number;
  tracks: TrackRuntimeState[];
}
