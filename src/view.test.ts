import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogData, LogLine } from './types.ts';
import { collect, fold, matchMessage, newest, perMinute, select } from './view.ts';

const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
const line = (s: number, msg: string, o: Partial<LogLine> = {}): LogLine => ({ t: T0 + s * 1000, first: T0 + s * 1000, count: 1, level: 'info', kind: 'journal', unit: 'nginx.service', msg, ...o });
const data = (kind: LogData['kind'], lines: LogLine[]): LogData => ({ kind, lines, alerts: lines.filter((l) => l.level === 'error' || l.level === 'warning'), status: { state: 'following' } });

test('every source’s lines together, oldest first', () => {
  const sources = { 'logs/journal': data('journal', [line(1, 'a'), line(5, 'c')]), 'logs/docker': data('docker', [line(3, 'b', { kind: 'docker', unit: 'web' })]), 'other/thing': { lines: 'nope' } };
  assert.deepEqual(collect(sources, 'lines').map((l) => l.msg), ['a', 'b', 'c']);
});

test('filters: lowest level, units by name or kind, message words, exclusions and regular expressions', () => {
  const all = [
    line(0, 'GET / 200'),
    line(1, 'upstream timed out', { level: 'error' }),
    line(2, 'healthcheck timed out', { level: 'warning' }),
    line(3, 'listening', { kind: 'docker', unit: 'web' }),
    line(4, 'HTTP 503 from api', { kind: 'file', unit: 'app.log', level: 'error' }),
    line(5, 'debug noise', { level: 'debug' }),
  ];
  const msgs = (o: Parameters<typeof select>[1]) => select(all, o).map((l) => l.msg);
  assert.deepEqual(msgs({ level: 'warning' }), ['upstream timed out', 'healthcheck timed out', 'HTTP 503 from api']);
  assert.deepEqual(msgs({ level: 'debug', units: ['docker/*'] }), ['listening']);
  assert.deepEqual(msgs({ units: ['!nginx.service'] }), ['listening', 'HTTP 503 from api']);
  assert.deepEqual(msgs({ messages: ['timed out', '!healthcheck'] }), ['upstream timed out']);
  assert.deepEqual(msgs({ messages: ['/\\b5\\d\\d\\b/'] }), ['HTTP 503 from api']);
  assert.deepEqual(msgs({ messages: ['GET*'] }), ['GET / 200'], 'a glob matches the whole message');
  assert.equal(matchMessage('x', ['/(unclosed/']), true, 'a broken expression is ignored, not thrown');
});

test('repeats next to each other fold once filtered, counts added', () => {
  const lines = [line(0, 'timeout', { level: 'error', count: 3, first: T0 - 5000 }), line(1, 'noise'), line(2, 'timeout', { level: 'error' })];
  const folded = fold(select(lines, { level: 'warning' }));
  assert.equal(folded.length, 1);
  assert.deepEqual([folded[0]!.count, folded[0]!.first, folded[0]!.t], [4, T0 - 5000, T0 + 2000]);
  assert.equal(fold(lines).length, 3);
});

test('errors per minute: buckets over the span, groups spread over their time', () => {
  const now = T0 + 10 * 60_000;
  const lines = [line(30, 'a', { level: 'error' }), line(90, 'b', { level: 'error', count: 4, first: T0 + 61_000 }), line(-3600, 'too old', { level: 'error' })];
  const v = perMinute(lines, now, 10 * 60_000, 10);
  assert.equal(v.length, 10);
  assert.deepEqual(v.slice(0, 3), [1, 4, 0]);
  assert.equal(v.reduce((a, b) => a + b, 0), 5);
  // Wider buckets are scaled back to "per minute".
  assert.deepEqual(perMinute([line(0, 'x', { level: 'error', count: 1 })], T0 + 60_000, 10 * 60_000, 5).filter(Boolean), [0.5]);
  assert.equal(newest(lines.slice(0, 2))?.msg, 'b', 'the last of a list in time order');
});
