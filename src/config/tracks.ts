export const BASE_BPM = 80;
export const MIN_BPM = 60;
export const MAX_BPM = 100;
export const BPM_STEP = 2;

export type TrackId = 'violin' | 'cello' | 'piano_r' | 'piano_l' | 'click';

export interface TrackDefinition {
  id: TrackId;
  label: string;
  url: string;
  initialVolume: number;
}

export const TRACKS: TrackDefinition[] = [
  {
    id: 'violin',
    label: 'バイオリン',
    url: '/audio/violin.mp3',
    initialVolume: 0.85
  },
  {
    id: 'cello',
    label: 'チェロ',
    url: '/audio/cello.mp3',
    initialVolume: 0.85
  },
  {
    id: 'piano_r',
    label: 'ピアノ（右手）',
    url: '/audio/piano_r.mp3',
    initialVolume: 0.9
  },
  {
    id: 'piano_l',
    label: 'ピアノ（左手）',
    url: '/audio/piano_l.mp3',
    initialVolume: 0.9
  },
  {
    id: 'click',
    label: 'クリック',
    url: '/audio/click.mp3',
    initialVolume: 0.55
  }
];
