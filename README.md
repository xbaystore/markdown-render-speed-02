[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/xbaystore/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/xbaystore/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A Markdown-to-HTML renderer that reproduces the output of marked 18.1.3
byte for byte while parsing faster.

## Layout

- `parse.js` — the renderer. Exports `parse(markdown: string): string`.
- `main.ts` — the driver. Reads `cases.json` (an array of
  `{id, markdown}`) from `MAKEFUN_INPUT_DIR` (default `/input`), renders
  every case, and writes `html.json` — a JSON array of HTML strings in
  the input order — to `MAKEFUN_OUTPUT_DIR` (default `/output`).
- `vendor/marked/` — the vendored marked 18.1.3 build (MIT), kept as a
  reference implementation and as a fallback for constructs outside the
  fast paths.

## How it works

The renderer is a hand-written two-level parser:

1. A block pass walks the document line by line, producing headings,
   fenced and indented code, blockquotes, lists, tables, HTML blocks,
   thematic breaks, and paragraphs. Link reference definitions are
   collected document-wide during the same pass (they resolve even when
   they appear after their uses, including inside blockquotes and list
   items). Any block whose inline content uses a construct outside the
   fast paths is delegated to the vendored marked, with all collected
   definitions in scope, so output stays identical.
2. An inline pass scans paragraph text once into a node list — text
   runs, code spans, raw HTML, links and images (with nested-bracket
   label matching and reference resolution), autolinks, hard breaks —
   and then resolves emphasis, strong, and strikethrough with a
   delimiter-stack algorithm implementing the CommonMark flanking and
   rule-of-three rules plus the GFM autolink extension.

Escaping, entity handling, and URL cleaning follow the same rules as
the reference implementation, verified case by case against the
competition practice corpus.

## Running

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```
