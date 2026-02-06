# PianoLessonApp MVP

Vite + React + TypeScript で構築した、5トラック同期再生のMVPです。

## 前提

`public/audio/` に以下の音源を配置してください（ファイル名固定）。

- `/audio/violin.mp3`
- `/audio/cello.mp3`
- `/audio/piano_r.mp3`
- `/audio/piano_l.mp3`
- `/audio/click.mp3`

Worklet は `public/worklets/soundtouch-worklet.js` から読み込み、
`audioCtx.audioWorklet.addModule('/worklets/soundtouch-worklet.js')` で登録します。

## 起動手順

1. Node.js 18+ を用意
2. 依存インストール

```bash
npm install
```

3. 開発サーバ起動

```bash
npm run dev
```

4. ブラウザで表示された URL を開く

## npm scripts

- `npm run dev` : 開発サーバ
- `npm run build` : TypeScriptチェック + 本番ビルド
- `npm run preview` : build結果のプレビュー

## 実装概要

- Web Audio APIで5トラックを同期再生
- ミックス: 各トラック `GainNode` → 共通バス
- 共通バス後段に SoundTouch 系 AudioWorklet を1つ挿入
- `tempo = targetBpm / 80` で制御（初期BPM=80）
- `pitch` は常に `1`
- BPM範囲: 60〜100（2刻み）
- 再生中BPM変更時:
  - 現在の入力バッファ秒位置を計算
  - いったん全 `AudioBufferSourceNode` を停止
  - tempo更新
  - 同じ入力秒位置から再開
- クリップ防止のため master gain 初期値を `0.8`

## UI

- Start（初期化）/ Play / Pause / Stop
- BPM表示 + `[-]` `[+]`（2刻み）
- `Reset BPM=80`
- 5トラックごとの:
  - Muteトグル
  - Soloトグル
  - Volumeスライダー

## 動作確認手順

1. **クリック同期**
   - `Start` → `Play`。
   - `click` と他トラックの拍が大きく崩れないことを確認。

2. **Mute/Solo**
   - 任意トラックで `Mute` をON/OFFし、対象のみ消音されることを確認。
   - 1トラックだけ `Solo` をONにして、そのトラックだけ聞こえることを確認。

3. **BPM変更時の挙動**
   - 再生中に `[-]` / `[+]` でBPM変更。
   - 音楽位置が大きく飛ばず再開されることを確認。
   - 音程（キー）が変わらないことを確認。

## 対応ブラウザ

- Chrome / Edge の最新安定版を推奨
- Safari 17+（AudioWorklet対応環境）

## 既知の制約

- AudioContextはブラウザ制約によりユーザー操作（`Start`）後に初期化されます。
- `public/worklets/soundtouch-worklet.js` は
  `@soundtouchjs/audio-worklet` の配布ファイルを同梱しています。
- BPM変更時は要件どおり一旦 source を止めて再生成するため、環境によってはごく短いつなぎ目が聞こえる場合があります。
