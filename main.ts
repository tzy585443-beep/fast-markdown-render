// Harness driver: read the cases, render each one with parse(), write the HTML array.
// The harness runs `node /bot/main.ts`; outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases: { id: string; markdown: string }[] =
  JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const rendered = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
