import { writeFileSync } from 'node:fs';
import { runDemo } from './demo.js';

/** `npm run demo -- [--seed N] [--logins N] [--accounts N] [--out FILE]` */
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const result = await runDemo({ seed: Number(arg('seed', '42')), logins: Number(arg('logins', '50')), accounts: Number(arg('accounts', '1000')) });
const out = arg('out', 'COPY_REPORT.md');
writeFileSync(out, result.report);
console.log(result.report);
console.log(`Wrote ${out}`);
process.exit(0);
