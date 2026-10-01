# Pool Designer (Web)

屋内プールの響きを物理シミュレーションで作るリバーブの、ブラウザ版です。
隣のタブで再生している YouTube などの音に、そのままプールの響きをかけて聴けます。

**https://unidaijin.github.io/pool-designer-web/**

## 使い方

1. 隣のタブで YouTube を開いて再生する
2. 「タブの音を取り込む」を押し、共有ダイアログでそのタブを選んで **タブの音声も共有** をオンにする
3. 元のタブの音は止まり、プールの響きがかかった音だけが鳴る

- 図の L・W・H ラベルをドラッグ:部屋の寸法
- 図の「音源」「聴く位置」をドラッグ:位置
- 素材ボタン:すべての面の素材をまとめて変更
- 「詳細設定」:面ごとの素材、2つの素材の混合、気温・湿度などの細かい設定
- 「エフェクト ON / OFF」(スペースキーでも切り替え):オフにすると原音だけになる

ほかに、音声ファイル(ドラッグ&ドロップ可)・マイク・デモ曲も入力にできます。

## プラグイン版

DAW で使える AU / VST3 版(macOS)は [Releases](https://github.com/UNIDAIJIN/pool-designer-web/releases/tag/plugin-v0.1.0) からダウンロードできます。ページの一番下にもリンクがあります。

## 対応ブラウザ

- タブの音の取り込みは、パソコンの Chrome / Edge で使えます。
- スマホ(iPhone / Android)のブラウザには、ほかのタブやアプリの音を取り込む仕組みがないため、音声ファイル・マイク・デモ曲のみ使えます。

## しくみ

プラグイン版 Pool Designer(JUCE / C++)の音響モデルを JavaScript に移植しています。

- 鏡像法(鏡面反射)+ レイトレーシングの diffuse rain(散乱成分)で、直方体のプールのステレオ IR を生成(`js/model.js`、Web Worker で計算)
- 吸音率は 125 Hz〜8 kHz の7帯域、空気吸収は ISO 9613-1、両耳は Woodworth の ITD と帯域ごとの ILD
- 水面の1次反射は IR から外し、AudioWorklet の揺らぐ遅延線でリアルタイムに鳴らす(`js/water-worklet.js`)
- 畳み込みは ConvolverNode を2つ使い、部屋を変えたときはクロスフェードで切り替え(`js/audio.js`)

ビルドは不要です。ローカルで試すときは、このフォルダで `python3 -m http.server` を実行して http://localhost:8000 を開きます。

## デモ曲

MoritaSaki in the pool「BALLOON DOG」(`audio/balloon-dog.m4a`)。曲の著作権は MoritaSaki in the pool に帰属します。
