export const BASE_BPM = 80;
export const MIN_BPM = 60;
export const MAX_BPM = 100;
export const BPM_STEP = 2;
const AUDIO_REV = 'compare-v1';

export type TrackId = 'violin' | 'cello' | 'piano_r' | 'piano_l' | 'click';

export interface TrackDefinition {
  id: TrackId;
  label: string;
  url: string;
  initialVolume: number;
}

export type AudioPatternId = 'no72' | 'with72_rit' | 'with72_nonrit';

export interface AudioPatternDefinition {
  id: AudioPatternId;
  label: string;
  description: string;
  tracks: TrackDefinition[];
  displayBars: number[];
  twoBeatDisplayBars: number[];
  tempoHintsByDisplayBar?: Partial<Record<number, number>>;
}

const TRACK_META: Record<TrackId, { label: string; initialVolume: number }> = {
  violin: {
    label: 'バイオリン',
    initialVolume: 0.85
  },
  cello: {
    label: 'チェロ',
    initialVolume: 0.85
  },
  piano_r: {
    label: 'ピアノ（右手）',
    initialVolume: 0.9
  },
  piano_l: {
    label: 'ピアノ（左手）',
    initialVolume: 0.9
  },
  click: {
    label: 'クリック',
    initialVolume: 0.55
  }
};

const TRACK_ORDER: TrackId[] = ['violin', 'cello', 'piano_r', 'piano_l', 'click'];

const buildTracks = (urlByTrack: Record<TrackId, string>): TrackDefinition[] =>
  TRACK_ORDER.map((id) => ({
    id,
    label: TRACK_META[id].label,
    initialVolume: TRACK_META[id].initialVolume,
    url: `${urlByTrack[id]}?v=${AUDIO_REV}`
  }));

const buildDisplayBars = (includeBar72: boolean): number[] => {
  const bars: number[] = [];
  const firstPartLast = includeBar72 ? 72 : 71;

  for (let bar = 0; bar <= firstPartLast; bar += 1) {
    bars.push(bar);
  }
  for (let bar = 102; bar <= 110; bar += 1) {
    bars.push(bar);
  }

  return bars;
};

const NO72_TRACK_URLS: Record<TrackId, string> = {
  violin: '/audio/violin.mp3',
  cello: '/audio/cello.mp3',
  piano_r: '/audio/piano_r.mp3',
  piano_l: '/audio/piano_l.mp3',
  click: '/audio/click.mp3'
};

const WITH72_RIT_TRACK_URLS: Record<TrackId, string> = {
  violin: '/audio/patterns/violin_72_rit.mp3',
  cello: '/audio/patterns/cello_72_rit.mp3',
  piano_r: '/audio/patterns/piano_r_72_rit.mp3',
  piano_l: '/audio/patterns/piano_l_72_rit.mp3',
  click: '/audio/patterns/click_72_rit.mp3'
};

const WITH72_NONRIT_TRACK_URLS: Record<TrackId, string> = {
  violin: '/audio/patterns/violin_72_nonrit.mp3',
  cello: '/audio/patterns/cello_72_nonrit.mp3',
  piano_r: '/audio/patterns/piano_r_72_nonrit.mp3',
  piano_l: '/audio/patterns/piano_l_72_nonrit.mp3',
  click: '/audio/patterns/click_72_nonrit.mp3'
};

export const AUDIO_PATTERNS: AudioPatternDefinition[] = [
  {
    id: 'no72',
    label: '72小節なし',
    description: '72小節を省いた短縮版です。',
    tracks: buildTracks(NO72_TRACK_URLS),
    displayBars: buildDisplayBars(false),
    twoBeatDisplayBars: []
  },
  {
    id: 'with72_rit',
    label: '72小節あり（rit）',
    description: '72小節あり。72小節目は2拍子、リタルダンドありです。',
    tracks: buildTracks(WITH72_RIT_TRACK_URLS),
    displayBars: buildDisplayBars(true),
    twoBeatDisplayBars: [72],
    tempoHintsByDisplayBar: {
      72: 60
    }
  },
  {
    id: 'with72_nonrit',
    label: '72小節あり（nonrit）',
    description: '72小節あり。72小節目は2拍子、一定テンポです。',
    tracks: buildTracks(WITH72_NONRIT_TRACK_URLS),
    displayBars: buildDisplayBars(true),
    twoBeatDisplayBars: [72]
  }
];

export const DEFAULT_AUDIO_PATTERN_ID: AudioPatternId = 'no72';

export const getAudioPattern = (id: AudioPatternId): AudioPatternDefinition =>
  AUDIO_PATTERNS.find((pattern) => pattern.id === id) ??
  AUDIO_PATTERNS.find((pattern) => pattern.id === DEFAULT_AUDIO_PATTERN_ID)!;

export const TRACKS: TrackDefinition[] = getAudioPattern(DEFAULT_AUDIO_PATTERN_ID).tracks;
