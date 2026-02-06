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
- BPM制御:
  - 各 `AudioBufferSourceNode.playbackRate = targetBpm / 80`
  - Worklet側は `tempo=1`, `rate=1`, `pitch=80/targetBpm` でピッチ補正
- BPM範囲: 60〜100（2刻み）
- アクセス時に自動初期化（`Start`ボタンなし）
- 再生中BPM変更時:
  - 現在の入力バッファ秒位置を計算
  - 再生を止めず `playbackRate` と `pitch` を滑らかに更新
  - 入力秒位置の基準を更新して同期を維持
- BPM変更時のノイズ低減:
  - `playbackRate` / `pitch` を短時間ランプで変更
  - Workletの出力不足時にゼロ埋めしない補間（前サンプル保持）
  - タイムストレッチ後にローパスを1段入れて高域のザラつきを抑制
  - master gain 初期値を `0.55` に調整
- click音源を解析して小節頭を推定し、バー番号 `0`〜`110` の開始位置を生成
  - 基本4拍子、2拍子混在、72小節目フェルマータ、0小節目あり、110小節終わりを想定

## UI

- Play / Pause / Stop
- BPM表示 + `[-]` `[+]`（2刻み）
- Position:
  - 現在時間と現在小節を表示
  - click解析済みの小節頭に対して、任意バーへ移動して開始可能
  - 再生中は小節スライダーが現在位置にあわせて自動で動く
  - `この小節へ` ボタンなし（小節変更は即時に開始位置へ反映）
- `Reset BPM=80`
- 5トラックごとの:
  - Muteトグル
  - Soloトグル
  - Volumeスライダー

## 動作確認手順

1. **クリック同期**
   - ページアクセス後、初期化が完了したら `Play`。
   - `click` と他トラックの拍が大きく崩れないことを確認。

2. **Mute/Solo**
   - 任意トラックで `Mute` をON/OFFし、対象のみ消音されることを確認。
   - 1トラックだけ `Solo` をONにして、そのトラックだけ聞こえることを確認。

3. **BPM変更時の挙動**
   - 再生中に `[-]` / `[+]` でBPM変更。
   - 音楽位置が大きく飛ばず再開されることを確認（短いフェードあり）。
   - 音程（キー）が変わらないことを確認。

4. **Position（小節頭開始）**
   - 小節スライダー/数値で任意小節を選択。
   - `Play` で選択バー頭から開始されることを確認。
   - 再生中に小節を変更した場合、そのバー頭にジャンプ再生されることを確認。

5. **Pause即時停止**
   - 再生中に `Pause`。
   - 音が即時に止まることを確認。

## 対応ブラウザ

- Chrome / Edge の最新安定版を推奨
- Safari 17+（AudioWorklet対応環境）

## 既知の制約

- 自動初期化時、ブラウザの自動再生制約により AudioContext が `suspended` になる場合があります（`Play` 操作で復帰）。
- `public/worklets/soundtouch-worklet.js` は
  `@soundtouchjs/audio-worklet` の配布ファイルを同梱しています。
- 小節頭解析は click波形のピーク検出に基づく推定です。録音状態によっては一部小節位置の手調整が必要になる場合があります。
