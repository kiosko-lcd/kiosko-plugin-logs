import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBaseContext } from '@kiosko/sdk';
import { defaultDockerSocket } from './docker.ts';
import { followDocker, followJournal, journalArgs, kubeArgs, lokiTail, macosArgs, windowsScript, type Hooks } from './follow.ts';
import type { Entry } from './parse.ts';
import { file, journal, watchWith } from './sources.ts';
import { supervise } from './supervise.ts';
import type { LogData, LogStatus } from './types.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-journalctl.mjs', import.meta.url));
const unix = process.platform === 'win32' && 'shebang scripts and Unix sockets';
const tmp = () => mkdtempSync(join(tmpdir(), 'kiosko-logs-'));

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function hooks() {
  const ac = new AbortController();
  const entries: Entry[] = [];
  const statuses: LogStatus[] = [];
  const h: Hooks = { signal: ac.signal, add: (e) => entries.push(e), status: (s) => statuses.push(s), log: () => undefined };
  return { h, entries, statuses, stop: () => ac.abort() };
}

test('the commands each follower runs', () => {
  assert.deepEqual(journalArgs({ priority: 'warning', onlyUser: true }), ['--follow', '--output=json', '--lines=200', '--priority=4', '--no-pager', '--quiet', '--user']);
  assert.equal(journalArgs({ priority: 'info', onlyUser: false }, 's=abc;i=12')[2], '--after-cursor=s=abc;i=12', 'a restart goes on where it left off');
  assert.deepEqual(macosArgs({ predicate: ' process == "nginx" ', level: 'info' }), ['stream', '--style', 'ndjson', '--level', 'info', '--predicate', 'process == "nginx"']);
  assert.deepEqual(kubeArgs({ selector: 'app=shop', namespace: 'web', context: '' }).slice(-4), ['--namespace', 'web', '--selector', 'app=shop']);
  assert.equal(kubeArgs({ selector: 'deployment/shop', namespace: '', context: 'lab' }).at(-1), 'deployment/shop');
  assert.ok(kubeArgs({ selector: 'x', namespace: '', context: '' }, Date.UTC(2026, 10, 21)).includes('--since-time=2026-11-21T00:00:00.000Z'));
  // A log name with a quote can't break out of the PowerShell string.
  const ps = windowsScript({ logs: ["System", "it's'; Remove-Item x"], priority: 'warning' }, 1_700_000_000_000);
  assert.match(ps, /LogName=@\('System','it''s''; Remove-Item x'\)/);
  assert.match(ps, /Level=@\(1,2,3\)/);
  assert.match(ps, /FromUnixTimeMilliseconds\(1700000000000\)/);
  const loki = lokiTail({ url: 'https://ana:pw@loki.example.lan:3100/', query: '{job="nginx"}', token: '', orgId: 'home' }, 1000);
  assert.equal(loki.url, 'wss://loki.example.lan:3100/loki/api/v1/tail?query=%7Bjob%3D%22nginx%22%7D&limit=100&start=1001000000');
  assert.deepEqual(loki.headers, { Authorization: `Basic ${Buffer.from('ana:pw').toString('base64')}`, 'X-Scope-OrgID': 'home' });
  assert.equal(lokiTail({ url: 'http://loki:3100', query: '{a="b"}', token: 'tok', orgId: '' }).headers.Authorization, 'Bearer tok');
});

test('the Docker socket, when none is set: DOCKER_HOST, rootless, Desktop, the system one', () => {
  const none = () => false;
  assert.equal(defaultDockerSocket({ env: { DOCKER_HOST: 'unix:///srv/d.sock' }, exists: none }), '/srv/d.sock');
  assert.equal(defaultDockerSocket({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux', exists: (p) => p === '/run/user/1000/docker.sock' }), '/run/user/1000/docker.sock');
  assert.equal(defaultDockerSocket({ env: {}, home: '/Users/ana', platform: 'darwin', exists: (p) => p === '/Users/ana/.docker/run/docker.sock' }), '/Users/ana/.docker/run/docker.sock');
  assert.equal(defaultDockerSocket({ env: {}, platform: 'linux', exists: none }), '/var/run/docker.sock');
  assert.equal(defaultDockerSocket({ env: {}, platform: 'win32', exists: none }), '\\\\.\\pipe\\docker_engine');
});

test('a dead follower is started again, waiting longer each time', async () => {
  const ac = new AbortController();
  const starts: number[] = [];
  const statuses: LogStatus[] = [];
  const t0 = Date.now();
  const run = supervise(
    async () => {
      starts.push(Date.now() - t0);
      throw new Error('journalctl: not found');
    },
    { signal: ac.signal, status: (s) => statuses.push(s), minMs: 20, maxMs: 80 },
  );
  await until(() => starts.length >= 5, 'five starts');
  ac.abort();
  await run;
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
  assert.ok(gaps[0]! >= 15 && gaps[1]! >= 35 && gaps[2]! >= 75 && gaps[3]! >= 75 && gaps[3]! < 200, `gaps ${gaps}`);
  assert.deepEqual(statuses[0], { state: 'error', message: 'journalctl: not found' });
});

test('journald through a stand-in journalctl: units filtered, restarted when it dies', { skip: unix }, async () => {
  const dir = tmp();
  const entries = [
    { __CURSOR: 's=1;i=1', __REALTIME_TIMESTAMP: '1795255201000000', PRIORITY: '3', _SYSTEMD_UNIT: 'backup.service', MESSAGE: 'repository locked' },
    { __CURSOR: 's=1;i=2', __REALTIME_TIMESTAMP: '1795255202000000', PRIORITY: '6', _SYSTEMD_UNIT: 'cron.service', MESSAGE: 'hourly jobs' },
    { __CURSOR: 's=1;i=3', __REALTIME_TIMESTAMP: '1795255203000000', PRIORITY: '4', _SYSTEMD_UNIT: 'user@1000.service', _SYSTEMD_USER_UNIT: 'sync.service', MESSAGE: 'slow' },
  ];
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(entries));
  process.env.FAKE_JOURNAL = join(dir, 'journal.json');
  process.env.FAKE_ARGS = join(dir, 'args');
  process.env.FAKE_DIE = '1';
  const f = hooks();
  const run = followJournal({ units: ['!cron.service'], priority: 'info', onlyUser: false, bin: FAKE }, f.h);
  await until(() => f.entries.length >= 4, 'lines from two runs');
  f.stop();
  await run;
  delete process.env.FAKE_DIE;
  assert.deepEqual(f.entries.slice(0, 2).map((e) => [e.unit, e.level, e.msg]), [
    ['backup.service', 'error', 'repository locked'],
    ['sync.service', 'warning', 'slow'],
  ]);
  assert.ok(f.statuses.some((s) => s.state === 'error' && /failed \(1\): Failed to open journal: fake failure/.test(s.message ?? '')), JSON.stringify(f.statuses));
  const runs = readFileSync(join(dir, 'args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  assert.ok(runs[0]!.includes('--lines=200') && runs[0]!.includes('--priority=6'));
  assert.ok(runs[1]!.includes('--after-cursor=s=1;i=3'), 'the second run goes on after the last line seen');
  rmSync(dir, { recursive: true });
});

/** A stand-in Docker API on a Unix socket: two containers, frames for their logs. */
function fakeDocker(sock: string) {
  const open = new Set<ServerResponse>();
  let containers = [
    { Id: 'aaa111', Names: ['/shop-web'], Labels: { 'com.docker.compose.service': 'web' } },
    { Id: 'bbb222', Names: ['/db'], Labels: {} },
  ];
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.method + ' ' + req.url);
    const url = new URL(req.url!, 'http://docker');
    if (url.pathname === '/containers/json') return res.end(JSON.stringify(containers));
    const m = /^\/containers\/(\w+)\/(json|logs)$/.exec(url.pathname);
    if (m?.[2] === 'json') return res.end(JSON.stringify({ Config: { Tty: false } }));
    if (m?.[2] === 'logs') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
      res.write(frame(1, '2026-11-21T10:00:00.000000001Z listening on :8080\n'));
      res.write(frame(2, '2026-11-21T10:00:01.5Z ERROR payment provider unreachable (token=abc123)\n'));
      open.add(res);
      return;
    }
    res.writeHead(404).end('{}');
  });
  return {
    requests,
    listen: () => new Promise<void>((r) => server.listen(sock, () => r())),
    stopContainer: () => {
      containers = containers.slice(1);
      for (const r of open) r.end();
      open.clear();
    },
    close: () => new Promise<void>((r) => {
      for (const res of open) res.end();
      server.close(() => r());
    }),
  };
}

test('Docker through a stand-in API: only the chosen containers, frames read, a stopped one let go', { skip: unix }, async () => {
  const dir = tmp();
  const sock = join(dir, 'docker.sock');
  const api = fakeDocker(sock);
  await api.listen();
  const f = hooks();
  const run = followDocker({ containers: ['web'], socket: sock }, f.h, 50);
  await until(() => f.entries.length >= 2, 'two lines');
  assert.deepEqual(f.entries.map((e) => [e.unit, e.level, e.msg, e.t]), [
    ['shop-web', 'info', 'listening on :8080', Date.UTC(2026, 10, 21, 10, 0, 0)],
    ['shop-web', 'error', 'payment provider unreachable (token=abc123)', Date.UTC(2026, 10, 21, 10, 0, 1, 500)],
  ]);
  assert.ok(!api.requests.some((r) => r.includes('bbb222')), 'db was not chosen');
  assert.ok(api.requests.every((r) => r.startsWith('GET ')), 'only GET requests');
  assert.ok(api.requests.some((r) => /logs\?follow=1&stdout=1&stderr=1&timestamps=1&tail=50/.test(r)));
  assert.equal(f.statuses.at(-1)?.state, 'following');
  api.stopContainer();
  await until(() => f.statuses.at(-1)?.state === 'waiting', 'no container left');
  f.stop();
  await run;
  await api.close();
  rmSync(dir, { recursive: true });
});

test('Docker without its socket: an error that says so, retried', { skip: unix }, async () => {
  const f = hooks();
  const run = followDocker({ containers: ['*'], socket: join(tmp(), 'nope.sock') }, f.h);
  await until(() => f.statuses.length > 0, 'a status');
  f.stop();
  await run;
  assert.match(f.statuses[0]!.message ?? '', /Docker: no socket at .*nope\.sock/);
});

test('a source emits at most once a gap, says why it is off, and stops its follower', async () => {
  const base = createBaseContext({ now: Date.now() });
  const ctx = (options: unknown, signal = new AbortController().signal) => ({ ...base, options, signal, intervalMs: 0, timeoutMs: 0 }) as never;
  // Nothing to follow: one emit, with the reason, and nothing run.
  const got: LogData[] = [];
  const stopOff = file.watch!(ctx({ paths: [] }), (d) => got.push(d));
  assert.deepEqual(got.map((d) => d.status), [{ state: 'off', message: 'no log file set' }]);
  stopOff();
  // A follower adding 500 lines in a burst: emitted twice, not 500 times.
  const emits: LogData[] = [];
  let stopped = false;
  const watch = watchWith<{}>(
    'file',
    async (_o, h) => {
      for (let i = 0; i < 500; i++) h.add({ t: Date.now(), level: 'info', unit: 'app.log', msg: `line ${i}` });
      await new Promise<void>((r) => h.signal.addEventListener('abort', () => r()));
      stopped = true;
    },
    60,
  );
  const stop = watch(ctx({}), (d) => emits.push(d));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(emits.length, 2);
  assert.equal(emits.at(-1)!.lines.at(-1)!.msg, 'line 499');
  stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(stopped, 'the follower saw the abort');
  // journald elsewhere than Linux is off, not an error.
  if (process.platform !== 'linux') {
    const j: LogData[] = [];
    journal.watch!(ctx({ units: [], priority: 'info', onlyUser: false, bin: '' }), (d) => j.push(d))();
    assert.equal(j[0]?.status.state, 'off');
  }
});
