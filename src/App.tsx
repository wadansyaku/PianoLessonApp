import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { createAudioEngine } from './audio/AudioEngine';
import { BASE_BPM, BPM_STEP, MAX_BPM, MIN_BPM } from './config/tracks';
import type { TrackId } from './config/tracks';

const formatSec = (value: number): string => {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const App = (): JSX.Element => {
  const engine = useMemo(() => createAudioEngine(), []);
  const [engineState, setEngineState] = useState(() => engine.getState());
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    setEngineState(engine.getState());
  }, [engine]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setEngineState(engine.getState());
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [engine]);

  const runAction = useCallback(
    async (action: () => Promise<void> | void): Promise<void> => {
      setError(null);
      try {
        await action();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unexpected error occurred.');
      } finally {
        refreshState();
      }
    },
    [refreshState]
  );

  const handleToggleMute = (trackId: TrackId): void => {
    engine.toggleMute(trackId);
    refreshState();
  };

  const handleToggleSolo = (trackId: TrackId): void => {
    engine.toggleSolo(trackId);
    refreshState();
  };

  const handleVolumeChange = (trackId: TrackId, value: number): void => {
    engine.setVolume(trackId, value);
    refreshState();
  };

  const isReady = engineState.initialized && !engineState.loading;

  return (
    <main className="app-shell">
      <section className="card">
        <h1>Piano Lesson MVP</h1>
        <p className="subtext">
          StartでAudioContextを初期化し、5トラックを同期再生します。BPM変更時は同一音楽位置から再開します。
        </p>

        <div className="transport-row">
          <button
            type="button"
            onClick={() => {
              void runAction(() => engine.init());
            }}
            disabled={engineState.initialized || engineState.loading}
          >
            {engineState.loading ? 'Starting...' : 'Start'}
          </button>
          <button
            type="button"
            onClick={() => {
              void runAction(() => engine.play());
            }}
            disabled={!isReady || engineState.playing}
          >
            Play
          </button>
          <button
            type="button"
            onClick={() => {
              engine.pause();
              refreshState();
            }}
            disabled={!isReady || !engineState.playing}
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => {
              engine.stop();
              refreshState();
            }}
            disabled={!isReady || (!engineState.playing && engineState.currentInputSec === 0)}
          >
            Stop
          </button>
        </div>

        <div className="status-grid">
          <div>
            <span className="label">BPM</span>
            <div className="bpm-controls">
              <button
                type="button"
                onClick={() => {
                  void runAction(() => engine.changeBpm(-BPM_STEP));
                }}
                disabled={!isReady || engineState.bpm <= MIN_BPM}
              >
                -
              </button>
              <strong>{engineState.bpm}</strong>
              <button
                type="button"
                onClick={() => {
                  void runAction(() => engine.changeBpm(BPM_STEP));
                }}
                disabled={!isReady || engineState.bpm >= MAX_BPM}
              >
                +
              </button>
            </div>
          </div>

          <div>
            <span className="label">Tempo Ratio</span>
            <strong>{engineState.tempoRatio.toFixed(2)}</strong>
          </div>

          <div>
            <span className="label">Position</span>
            <strong>
              {formatSec(engineState.currentInputSec)} / {formatSec(engineState.durationSec)}
            </strong>
          </div>
        </div>

        <button
          type="button"
          className="reset-button"
          onClick={() => {
            void runAction(() => engine.resetBpm());
          }}
          disabled={!isReady || engineState.bpm === BASE_BPM}
        >
          Reset BPM=80
        </button>

        <h2>Tracks</h2>
        <div className="track-list">
          {engineState.tracks.map((track) => (
            <article key={track.id} className="track-row">
              <header>
                <strong>{track.label}</strong>
                <small>gain {track.effectiveGain.toFixed(2)}</small>
              </header>

              <div className="track-actions">
                <button
                  type="button"
                  className={track.mute ? 'active' : ''}
                  onClick={() => handleToggleMute(track.id)}
                  disabled={!isReady}
                >
                  {track.mute ? 'Muted' : 'Mute'}
                </button>
                <button
                  type="button"
                  className={track.solo ? 'active' : ''}
                  onClick={() => handleToggleSolo(track.id)}
                  disabled={!isReady}
                >
                  {track.solo ? 'Solo On' : 'Solo'}
                </button>
                <label>
                  Vol
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={track.volume}
                    onChange={(event) => {
                      handleVolumeChange(track.id, Number(event.target.value));
                    }}
                    disabled={!isReady}
                  />
                </label>
              </div>
            </article>
          ))}
        </div>

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
};

export default App;
