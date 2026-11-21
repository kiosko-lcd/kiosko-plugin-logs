import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWidget, widgetState } from '@kiosko/sdk/testing';
import { LogBuffer } from './buffer.ts';
import type { Entry } from './parse.ts';
import type { Kind, LogData, LogStatus } from './types.ts';
import { last, rate, tail } from './widgets.ts';

const NOW = Date.UTC(2026, 10, 21, 10, 0, 0);
const src = (kind: Kind, entries: [secondsAgo: number, Entry['level'], string, string][], status: LogStatus = { state: 'following' }): LogData => {
  const b = new LogBuffer(kind);
  for (const [s, level, unit, msg] of entries) b.add({ t: NOW - s * 1000, level, unit, msg });
  return b.snapshot(status);
};

test('the tail: newest first, ages, units, folded repeats and level colours, masked', () => {
  const sources = {
    'logs/journal': src('journal', [
      [300, 'info', 'cron', 'hourly jobs'],
      [120, 'error', 'nginx.service', 'upstream timed out'],
      [90, 'error', 'nginx.service', 'upstream timed out'],
      [60, 'error', 'nginx.service', 'upstream timed out'],
      [30, 'warning', 'smartd', 'pending sectors on /dev/sda'],
    ]),
    'logs/docker': src('docker', [[10, 'info', 'web', 'GET /?token=abc123 200']]),
  };
  const r = renderWidget(tail, { sources, now: NOW, size: { w: 900, h: 300 } });
  assert.equal(r.error, undefined);
  assert.equal(r.outside, 0);
  assert.deepEqual(r.texts.slice(1, 3), ['web', 'GET /?token=*** 200'], 'the newest first: its age, where, what');
  assert.ok(r.texts.includes('×3'), r.texts.join(' | '));
  assert.ok(r.texts.indexOf('pending sectors on /dev/sda') < r.texts.indexOf('upstream timed out'));
  assert.ok(r.texts.indexOf('upstream timed out') < r.texts.indexOf('hourly jobs'));
  // Filters: only errors; only docker.
  assert.deepEqual(renderWidget(tail, { sources, now: NOW, options: { level: 'error', showTime: false, showUnits: false } }).texts, ['×3', 'upstream timed out']);
  assert.deepEqual(renderWidget(tail, { sources, now: NOW, options: { units: ['docker/*'], showTime: false, showUnits: false } }).texts, ['GET /?token=*** 200']);
});

test('the tail with nothing: why, in its tile', () => {
  const off = { 'logs/file': src('file', [], { state: 'off', message: 'no log file set' }), 'logs/journal': src('journal', [], { state: 'error', message: 'journalctl: not found' }) };
  assert.deepEqual(renderWidget(tail, { sources: off, now: NOW }).texts, ['journalctl: not found']);
  assert.match(renderWidget(tail, { sources: { 'logs/file': src('file', [], { state: 'off' }) }, now: NOW, locale: 'es' }).texts[0]!, /Nada que seguir/);
  assert.match(renderWidget(tail, { sources: { 'logs/file': src('file', [[5, 'debug', 'a', 'b']]) }, now: NOW }).texts[0]!, /Quiet/);
  assert.equal(widgetState(tail, 'empty', { sources: off, now: NOW }), true);
});

test('urgent while an error is fresh, idle when the logs are quiet', () => {
  const fresh = { 'logs/journal': src('journal', [[30, 'error', 'backup.service', 'repository locked']]) };
  const old = { 'logs/journal': src('journal', [[3600, 'error', 'backup.service', 'repository locked'], [60, 'info', 'cron', 'ok']]) };
  for (const w of [tail, rate, last]) {
    assert.equal(widgetState(w, 'urgent', { sources: fresh, now: NOW }), true, w.id);
    assert.equal(widgetState(w, 'urgent', { sources: fresh, now: NOW, options: { holdMs: 10_000 } }), false, `${w.id}: past holdMs`);
    assert.equal(widgetState(w, 'urgent', { sources: fresh, now: NOW, options: { holdMs: 0 } }), false, `${w.id}: 0 is never`);
    assert.equal(widgetState(w, 'urgent', { sources: fresh, now: NOW, options: { units: ['!backup.service'] } }), false, `${w.id}: filtered out`);
    assert.equal(widgetState(w, 'idle', { sources: fresh, now: NOW }), false, w.id);
    assert.equal(widgetState(w, 'idle', { sources: old, now: NOW }), true, w.id);
  }
});

test('errors per minute: the count over the span and a curve', () => {
  const entries: [number, Entry['level'], string, string][] = [];
  for (let m = 0; m < 30; m++) entries.push([m * 60 + 5, m % 3 ? 'warning' : 'error', 'nginx.service', m % 3 ? 'slow' : 'timeout']);
  const sources = { 'logs/journal': src('journal', entries) };
  const r = renderWidget(rate, { sources, now: NOW, size: { w: 480, h: 200 } });
  assert.equal(r.outside, 0);
  assert.deepEqual(r.texts.slice(0, 2), ['10', 'errors in 1 h']);
  assert.equal(renderWidget(rate, { sources, now: NOW, options: { historyMs: 15 * 60_000 } }).texts[0], '5');
  assert.equal(renderWidget(rate, { sources: {}, now: NOW, locale: 'es' }).texts[1], 'errores en 1 h');
});

test('the last error, big, with where, when and how many times', () => {
  const sources = {
    'logs/journal': src('journal', [
      [600, 'error', 'backup.service', 'repository locked'],
      [100, 'warning', 'smartd', 'pending sectors'],
      [50, 'error', 'nginx.service', 'upstream timed out'],
      [40, 'error', 'nginx.service', 'upstream timed out'],
    ]),
  };
  const r = renderWidget(last, { sources, now: NOW, size: { w: 420, h: 200 } });
  assert.equal(r.outside, 0);
  assert.equal(r.texts[0], 'nginx.service');
  assert.match(r.texts[1]!, /×2$/);
  assert.equal(r.texts.slice(2).join(' '), 'upstream timed out');
  assert.equal(renderWidget(last, { sources, now: NOW, options: { units: ['!nginx*'], includeWarnings: true } }).texts[0], 'smartd');
  assert.deepEqual(renderWidget(last, { sources: { 'logs/journal': src('journal', [[5, 'info', 'cron', 'ok']]) }, now: NOW }).texts, ['No errors']);
});

test('the demo shows masking at work and has no real-looking secret left', () => {
  const r = renderWidget(tail, { now: NOW, size: { w: 1200, h: 462 }, options: { level: 'debug' } });
  const all = r.texts.join('\n');
  assert.match(all, /token=\*\*\*/);
  assert.match(all, /\*\*\*@\*\*\*/);
  assert.doesNotMatch(all, /Winter2026|demo-abc123|ana\.garcia/);
});
