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
  const selectableBars = engineState.selectableBars;
  const minSelectableBar = selectableBars[0] ?? 0;
  const maxSelectableBar = selectableBars[selectableBars.length - 1] ?? 0;
  const maxSelectableIndex = Math.max(0, selectableBars.length - 1);

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

  const clampBar = useCallback(
    (rawValue: number): number => {
      if (selectableBars.length === 0) {
        return 0;
      }

      const rounded = Math.round(rawValue);
      let nearest = selectableBars[0];
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const bar of selectableBars) {
        const distance = Math.abs(bar - rounded);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = bar;
        }
      }

      return nearest;
    },
    [selectableBars]
  );

  const findSelectableIndex = useCallback(
    (bar: number): number => {
      if (selectableBars.length === 0) {
        return 0;
      }

      const nearestBar = clampBar(bar);
      const found = selectableBars.indexOf(nearestBar);
      return found >= 0 ? found : 0;
    },
    [clampBar, selectableBars]
  );

  const pendingBarIndex = findSelectableIndex(pendingBar);

  const updateStartBar = (rawValue: number): void => {
    if (!Number.isFinite(rawValue)) {
      return;
    }

    setPendingBar(clampBar(rawValue));
  };

  const commitStartBar = (): void => {
    if (!isReady) {
      return;
    }

    const next = clampBar(pendingBar);
    setPendingBar(next);
    void runAction(() => engine.setStartBar(next));
  };

  const commitBarDirectly = (rawValue: number): void => {
    if (!isReady) {
      return;
    }

    const next = clampBar(rawValue);
    setPendingBar(next);
    void runAction(() => engine.setStartBar(next));
  };

  const moveBarBy = (delta: number): void => {
    if (selectableBars.length === 0) {
      return;
    }

    const nextIndex = Math.min(maxSelectableIndex, Math.max(0, pendingBarIndex + delta));
    commitBarDirectly(selectableBars[nextIndex] ?? minSelectableBar);
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
            <div className="bar-jump-buttons">
              <button
                type="button"
                onClick={() => {
                  moveBarBy(-8);
                }}
                disabled={!isReady || pendingBarIndex <= 0}
              >
                -8
              </button>
              <button
                type="button"
                onClick={() => {
                  moveBarBy(-4);
                }}
                disabled={!isReady || pendingBarIndex <= 0}
              >
                -4
              </button>
              <button
                type="button"
                onClick={() => {
                  moveBarBy(-1);
                }}
                disabled={!isReady || pendingBarIndex <= 0}
              >
                -1
              </button>
              <button
                type="button"
                onClick={() => {
                  moveBarBy(1);
                }}
                disabled={!isReady || pendingBarIndex >= maxSelectableIndex}
              >
                +1
              </button>
              <button
                type="button"
                onClick={() => {
                  moveBarBy(4);
                }}
                disabled={!isReady || pendingBarIndex >= maxSelectableIndex}
              >
                +4
              </button>
              <button
                type="button"
                onClick={() => {
                  moveBarBy(8);
                }}
                disabled={!isReady || pendingBarIndex >= maxSelectableIndex}
              >
                +8
              </button>
            </div>
            <div className="position-inputs">
              <input
                type="range"
                min={0}
                max={maxSelectableIndex}
                step={1}
                value={pendingBarIndex}
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
                  const nextIndex = Number(event.target.value);
                  updateStartBar(selectableBars[nextIndex] ?? minSelectableBar);
                }}
                disabled={!isReady}
              />
              <input
                type="number"
                min={minSelectableBar}
                max={maxSelectableBar}
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
