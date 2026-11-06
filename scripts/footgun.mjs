#!/usr/bin/env node
/**
 * Apply ONE footgun patch on top of the clean baseline, run the suite, then revert the patch.
 *
 * A suite is only worth trusting if it goes red when the code makes the mistakes real
 * copiers make. Each footgun reintroduces one of them; the manifest names the tests that
 * must catch it. The verdict is strict:
 *
 *   PASS (exit 0)  exactly the documented tests failed, every other test stayed green
 *   FAIL (exit 1)  a documented test stayed green, an undocumented test failed, or the runner broke
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = process.platform === 'win32';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'footguns', 'manifest.json'), 'utf8'));

const name = process.argv[2];
if (!name || !manifest[name]) {
  console.error('Usage: npm run footgun <name>\n\nAvailable footguns:');
  for (const [key, value] of Object.entries(manifest)) console.error(`  ${key}\n      ${value.description}`);
  process.exit(1);
}
const entry = manifest[name];
const patch = join('footguns', `${name}.patch`);

git(['apply', '--check', patch], `checking that ${patch} applies to the baseline`);
git(['apply', patch], `applying footgun ${name}`);
const revert = () => git(['apply', '-R', patch], `reverting footgun ${name}`);
process.on('SIGINT', () => {
  revert();
  process.exit(130);
});

let failed;
try {
  console.log(`\n--- footgun applied: ${name} -- ${entry.description}`);
  console.log('--- running the suite; the documented tests MUST fail now ---\n');
  failed = runSuite();
} finally {
  revert();
}

if (failed === undefined) {
  console.error('vitest produced no report -- infrastructure failure, not a verdict.');
  process.exit(1);
}

const matches = (test, expected) => test.includes(expected);
const missing = entry.expectedFailures.filter((e) => !failed.some((f) => matches(f, e)));
const unexpected = failed.filter((f) => !entry.expectedFailures.some((e) => matches(f, e)));

console.log(`\nFailed with ${name} applied (${failed.length}):`);
for (const f of failed) console.log(`  x ${f}`);
if (missing.length) {
  console.error('\nDocumented tests that stayed GREEN (the footgun went unnoticed there):');
  for (const m of missing) console.error(`  - ${m}`);
}
if (unexpected.length) {
  console.error('\nUndocumented tests that FAILED:');
  for (const u of unexpected) console.error(`  - ${u}`);
}
if (missing.length || unexpected.length) {
  console.error(`\nFAIL: ${name} -- expected exactly: ${entry.expectedFailures.join(', ')}`);
  process.exit(1);
}
console.log(`\nPASS: ${name} -- exactly the documented tests failed: ${entry.expectedFailures.join(', ')}`);

function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'trade-copier-footgun-'));
  const report = join(dir, 'report.json');
  try {
    spawnSync('npx', ['vitest', 'run', '--reporter=dot', '--reporter=json', `--outputFile.json=${report}`], {
      cwd: root,
      stdio: 'inherit',
      shell,
    });
    if (!existsSync(report)) return undefined;
    const results = JSON.parse(readFileSync(report, 'utf8'));
    const out = [];
    for (const file of results.testResults ?? []) {
      const failures = (file.assertionResults ?? []).filter((t) => t.status === 'failed');
      for (const t of failures) out.push(t.fullName ?? t.title);
      if (file.status === 'failed' && failures.length === 0) {
        out.push(`${file.name} (suite-level failure: ${String(file.message ?? 'unknown').split(/\r?\n/)[0]})`);
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(args, label) {
  console.log(`--- ${label} ---`);
  const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Command failed: git ${args.join(' ')}`);
    process.exit(1);
  }
}
