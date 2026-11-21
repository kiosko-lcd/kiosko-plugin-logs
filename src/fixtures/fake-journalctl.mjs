#!/usr/bin/env node
// Stands in for `journalctl -f -o json` in the tests: prints the invented
// entries of FAKE_JOURNAL (a JSON file) one per line, writes its arguments
// to FAKE_ARGS, then either dies (FAKE_DIE=1, to test the restart) or
// stays, like `-f` does, until it is killed.
import { appendFileSync, readFileSync } from 'node:fs';

if (process.env.FAKE_ARGS) appendFileSync(process.env.FAKE_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`);
for (const e of JSON.parse(readFileSync(process.env.FAKE_JOURNAL, 'utf8'))) process.stdout.write(`${JSON.stringify(e)}\n`);
if (process.env.FAKE_DIE) {
  process.stderr.write('Failed to open journal: fake failure\n');
  process.exit(1);
}
setInterval(() => {}, 1000);
