import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { followFile } from './follow-file.ts';
import type { LogStatus } from './types.ts';

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond` holds (or fails after 3 s). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (cond()) return;
    await tick(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function start(path: string, o: { backlogBytes?: number; skipBytes?: number } = {}) {
  const lines: string[] = [];
  const statuses: LogStatus[] = [];
  const ac = new AbortController();
  const done = followFile(path, { signal: ac.signal, onLine: (l) => lines.push(l), status: (s) => statuses.push(s), pollMs: 20, ...o });
  return { lines, statuses, stop: async () => (ac.abort(), await done) };
}

test('follows the end: the last lines first, then what is appended (a line written in two goes is one)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-logs-'));
  const path = join(dir, 'app.log');
  writeFileSync(path, `${'old line\n'.repeat(500)}recent 1\nrecent 2\n`);
  const f = start(path, { backlogBytes: 40 });
  await until(() => f.lines.includes('recent 2'), 'the backlog');
  assert.ok(f.lines.length <= 5, `only the end of the file: ${f.lines.length} lines`);
  assert.ok(!f.lines.some((l) => l !== 'old line' && l.endsWith('line') && l !== 'recent 1'), 'no cut line');
  appendFileSync(path, 'new: half');
  await tick();
  appendFileSync(path, ' and the rest\nnext ünïcödé\n');
  await until(() => f.lines.includes('next ünïcödé'), 'appended lines');
  assert.ok(f.lines.includes('new: half and the rest'));
  assert.equal(f.statuses[0]?.state, 'following');
  await f.stop();
  rmSync(dir, { recursive: true });
});

test('survives rotation by renaming, truncation in place and a file that comes later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-logs-'));
  const path = join(dir, 'app.log');
  const f = start(path);
  await until(() => f.statuses.some((s) => s.state === 'waiting'), 'waiting for the file');
  writeFileSync(path, 'born\n');
  await until(() => f.lines.includes('born'), 'a file that appears is read from its start');
  // logrotate: the old file is renamed (and still written a little), a new one takes its name.
  appendFileSync(path, 'before rotation\n');
  renameSync(path, `${path}.1`);
  appendFileSync(`${path}.1`, 'late write to the old file\n');
  writeFileSync(path, 'after rotation\n');
  await until(() => f.lines.includes('after rotation'), 'the new file');
  assert.ok(f.lines.indexOf('before rotation') < f.lines.indexOf('after rotation'));
  // copytruncate / "> app.log": the same file, shorter.
  appendFileSync(path, 'a much longer line before truncation\n');
  await until(() => f.lines.includes('a much longer line before truncation'), 'the line before truncation');
  truncateSync(path, 0);
  await tick();
  appendFileSync(path, 'fresh\n');
  await until(() => f.lines.includes('fresh'), 'after truncation');
  await f.stop();
  rmSync(dir, { recursive: true });
});

test('a runaway file is skipped forward, not read to the last byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiosko-logs-'));
  const path = join(dir, 'app.log');
  writeFileSync(path, '');
  const f = start(path, { backlogBytes: 64, skipBytes: 4096 });
  await until(() => f.statuses.length > 0, 'opened');
  appendFileSync(path, `${'spam spam spam\n'.repeat(2000)}the end\n`);
  await until(() => f.lines.includes('the end'), 'the end of the burst');
  assert.ok(f.lines.length < 20, `${f.lines.length} lines read`);
  assert.match(f.lines[0]!, /skipped \d+ KB/);
  await f.stop();
  rmSync(dir, { recursive: true });
});
