# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/xbaystore/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/xbaystore/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in replacement for `marked` 18.1.3
(default options, GFM on). `parse(markdown)` returns exactly the HTML
`marked.parse(markdown)` returns, for every input — but faster.

`parse.js` is a hand-written CommonMark + GFM parser (block parser plus
a delimiter-stack inline parser). Constructs it does not cover fall back
to the vendored `marked` 18.1.3 in `vendor/marked/` (MIT, see
`vendor/marked/LICENSE` and `vendor/marked/NOTICE`), so the output is
always identical to marked's.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each one alone with `parse`, and writes the
HTML strings in order to `/output/html.json`.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *markdown*.');
```

No dependencies, no network, no WASM, no native addons. Runs on Node 22+.

<!-- rec5: clean rewrite in a fresh recorded session; content identical to HEAD 8917872 except this comment -->
