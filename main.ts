// Driver for the markdown-render-speed-02 entry.
//
// Reads the case list (an array of {id, markdown}) from cases.json in
// the input directory, renders every case with parse() from parse.js,
// and writes html.json to the output directory as a JSON array of HTML
// strings in exactly the input order.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

interface CaseInput {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw) as CaseInput[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
