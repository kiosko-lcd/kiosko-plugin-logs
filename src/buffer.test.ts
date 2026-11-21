import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogBuffer, throttle } from './buffer.ts';
import type { Entry } from './parse.ts';

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const e = (s: number, msg: string, level: Entry['level'] = 'info', unit = 'web'): Entry => ({ t: T0 + s * 1000, level, unit, msg });

test('a circular buffer: the latest lines, and warnings and errors kept apart', () => {
  const b = new LogBuffer('journal', { maxLines: 5, maxAlerts: 3 });
  for (let i = 0; i < 12; i++) b.add(e(i, `line ${i}`, i % 4 === 0 ? 'error' : 'info'));
  const d = b.snapshot({ state: 'following' });
  assert.deepEqual(d.lines.map((l) => l.msg), ['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
  assert.deepEqual(d.alerts.map((l) => l.msg), ['line 0', 'line 4', 'line 8']);
  assert.equal(d.kind, 'journal');
});

test('repeats fold into one line, even with a few others in between, and move to the end', () => {
  const b = new LogBuffer('docker');
  b.add(e(0, 'db gone', 'error'));
  b.add(e(1, 'retrying'));
  b.add(e(2, 'db gone', 'error'));
  b.add(e(3, 'db gone', 'error', 'worker'));
  b.add(e(4, 'db gone', 'error'));
  const lines = b.snapshot({ state: 'following' }).lines;
  assert.deepEqual(lines.map((l) => [l.unit, l.msg, l.count, l.first - T0, l.t - T0]), [
    ['web', 'retrying', 1, 1000, 1000],
    ['worker', 'db gone', 1, 3000, 3000],
    ['web', 'db gone', 3, 0, 4000],
  ]);
});

test('warnings and errors fold within a minute only, so a burst keeps its shape', () => {
  const b = new LogBuffer('journal');
  for (let s = 0; s < 180; s += 10) b.add(e(s, 'timeout', 'error'));
  const d = b.snapshot({ state: 'following' });
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0]!.count, 18);
  assert.deepEqual(d.alerts.map((a) => a.count), [6, 6, 6]);
});

test('a snapshot already handed out never changes afterwards', () => {
  const b = new LogBuffer('file');
  b.add(e(0, 'x'));
  const before = b.snapshot({ state: 'following' });
  b.add(e(1, 'x'));
  assert.equal(before.lines[0]!.count, 1);
  assert.equal(b.snapshot({ state: 'following' }).lines[0]!.count, 2);
});

test('lines are masked before they are kept', () => {
  const b = new LogBuffer('file');
  b.add(e(0, 'login with password=hunter22 from ana@example.com'));
  assert.equal(b.snapshot({ state: 'following' }).lines[0]!.msg, 'login with password=*** from ***@***');
});

test('the emitter: the first call at once, a burst folded into one at the end of the gap', async () => {
  let calls = 0;
  const th = throttle(() => calls++, 50);
  th.schedule();
  assert.equal(calls, 1);
  for (let i = 0; i < 100; i++) th.schedule();
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 2);
  th.schedule();
  th.cancel();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 2, 'nothing after cancel');
});
