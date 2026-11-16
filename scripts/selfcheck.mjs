// Local self-check: render the kit's practice cases with main.ts and compare every
// HTML string to the reference, reporting the first differing case and character.
// Usage: node scripts/selfcheck.mjs [kit-dir]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = process.argv[2] || process.env.MAKEFUN_KIT || '/workspace/mdfast/markdown-render-speed-02-kit';
const inputDir = join(kit, 'practice/input');
const expectedDoc = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8'));
const expected = expectedDoc.cases.map((entry) => entry.html);
const caseIds = expectedDoc.cases.map((entry) => entry.id);
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const outDir = mkdtempSync(join(tmpdir(), 'mdfast-check-'));

try {
  const started = process.hrtime.bigint();
  const run = spawnSync(process.execPath, [join(root, 'main.ts')], {
    cwd: root,
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: 'utf8',
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  if (run.status !== 0) {
    console.error(run.stderr);
    process.exit(run.status || 1);
  }

  const actual = JSON.parse(readFileSync(join(outDir, 'html.json'), 'utf8'));
  let passed = 0;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] === expected[i]) {
      passed++;
      continue;
    }
    const want = expected[i];
    const got = actual[i] ?? '';
    let at = 0;
    while (at < want.length && at < got.length && want[at] === got[at]) at++;
    const context = (s) => JSON.stringify(s.slice(Math.max(0, at - 40), at + 60));
    console.log(`MISMATCH ${i + 1}/${expected.length} case ${caseIds[i]} at character ${at}`);
    console.log(`  expected ${context(want)}`);
    console.log(`  actual   ${context(got)}`);
    break;
  }
  console.log(`${passed}/${expected.length} cases identical (${seconds.toFixed(3)}s)`);
  process.exitCode = passed === expected.length ? 0 : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
