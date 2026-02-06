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
  const [pendingBar, setPendingBar] = useState(0);
  const [isEditingBar, setIsEditingBar] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    setEngineState(engine.getState());
  }, [engine]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setEngineState(engine.getState());
    }, 90);

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

  useEffect(() => {
    void runAction(() => engine.init());
  }, [engine, runAction]);

  useEffect(() => {
    setPendingBar(engineState.selectedStartBar);
  }, [engineState.selectedStartBar]);

  useEffect(() => {
    if (engineState.playing && !isEditingBar) {
      setPendingBar(engineState.currentBar);
    }
  }, [engineState.playing, engineState.currentBar, isEditingBar]);

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

  const updateStartBar = (rawValue: number): void => {
    if (!Number.isFinite(rawValue)) {
      return;
    }

    const next = Math.min(engineState.maxBar, Math.max(0, Math.round(rawValue)));
    setPendingBar(next);
  };

  const commitStartBar = (): void => {
    if (!isReady) {
      return;
    }

    const next = Math.min(engineState.maxBar, Math.max(0, Math.round(pendingBar)));
    setPendingBar(next);
    void runAction(() => engine.setStartBar(next));
  };

  const isReady = engineState.initialized && !engineState.loading;

  return (
    <main className="app-shell">
      <section className="card">
        <h1>練習プレイヤー</h1>
        <p className="subtext">
          ページを開くと自動で準備します。小節をえらんで、その場所から再生できます。
        </p>

        <section className="top-panel">
          <div className="transport-row">
            <button
              type="button"
              onClick={() => {
                void runAction(() => engine.play());
              }}
              disabled={!isReady || engineState.playing}
            >
              再生
            </button>
            <button
              type="button"
              onClick={() => {
                engine.pause();
                refreshState();
              }}
              disabled={!isReady || !engineState.playing}
            >
              一時停止
            </button>
            <button
              type="button"
              onClick={() => {
                engine.stop();
                refreshState();
              }}
              disabled={!isReady || (!engineState.playing && engineState.currentInputSec === 0)}
            >
              最初に戻す
            </button>
          </div>

          <div className="status-grid">
            <div>
              <span className="label">速さ（BPM）</span>
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
              <span className="label">いまの場所</span>
              <strong>
                {formatSec(engineState.currentInputSec)} / {formatSec(engineState.durationSec)}
              </strong>
              <small>
                小節 {engineState.currentBar} / {engineState.maxBar}
              </small>
            </div>
          </div>

          <div className="position-picker">
            <span className="label">ここから再生する小節</span>
            <div className="position-inputs">
              <input
                type="range"
                min={0}
                max={engineState.maxBar}
                step={1}
                value={pendingBar}
                onPointerDown={() => {
                  setIsEditingBar(true);
                }}
                onPointerUp={() => {
                  setIsEditingBar(false);
                  commitStartBar();
                }}
                onBlur={() => {
                  setIsEditingBar(false);
                  commitStartBar();
                }}
                onChange={(event) => {
                  updateStartBar(Number(event.target.value));
                }}
                disabled={!isReady}
              />
              <input
                type="number"
                min={0}
                max={engineState.maxBar}
                step={1}
                value={pendingBar}
                onChange={(event) => {
                  updateStartBar(Number(event.target.value));
                }}
                onFocus={() => {
                  setIsEditingBar(true);
                }}
                onBlur={() => {
                  setIsEditingBar(false);
                  commitStartBar();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitStartBar();
                  }
                }}
                disabled={!isReady}
              />
            </div>
            <small>
              えらんだ小節: {engineState.selectedStartBar}（{formatSec(engineState.selectedStartSec)}）
            </small>
          </div>

          <button
            type="button"
            className="reset-button"
            onClick={() => {
              void runAction(() => engine.resetBpm());
            }}
            disabled={!isReady || engineState.bpm === BASE_BPM}
          >
            速さを80にもどす
          </button>
        </section>

        <section className="tracks-panel">
          <h2>パートごとの音</h2>
          <div className="track-list">
            {engineState.tracks.map((track) => (
              <article key={track.id} className="track-row">
                <header>
                  <strong>{track.label}</strong>
                </header>

                <div className="track-actions">
                  <button
                    type="button"
                    className={`track-toggle-button${track.mute ? ' active' : ''}`}
                    onClick={() => handleToggleMute(track.id)}
                    disabled={!isReady}
                  >
                    {track.mute ? '消音中' : '音を消す'}
                  </button>
                  <button
                    type="button"
                    className={`track-toggle-button${track.solo ? ' active' : ''}`}
                    onClick={() => handleToggleSolo(track.id)}
                    disabled={!isReady}
                  >
                    {track.solo ? 'この音だけ再生中' : 'これだけ聞く'}
                  </button>
                  <label>
                    音量
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
        </section>

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
};

export default App;
