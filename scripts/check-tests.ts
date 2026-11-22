import { readdirSync, readFileSync } from 'node:fs';
import { inspectTests } from './test-rules.js';

let failures = 0;
for (const name of readdirSync('tests').filter((file) =>
  file.endsWith('.test.ts')
)) {
  for (const violation of inspectTests(
    readFileSync(`tests/${name}`, 'utf8'),
    name
  )) {
    failures++;
    process.stderr.write(`${name}:${violation.line}: ${violation.rule}\n`);
  }
}
process.stdout.write(`Test governance: ${failures} violations\n`);
process.exitCode = failures ? 1 : 0;
