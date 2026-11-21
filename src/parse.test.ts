import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DockerDemux, cleanMessage, journalNames, levelFromPriority, parseJournal, parseKubeLine, parseLokiMessage, parseMacos, parseText, parseWindowsEvents, splitDockerTimestamp } from './parse.ts';

const NOW = Date.UTC(2026, 10, 21, 10, 0, 0);

test('journald: time, priority, unit and message of `journalctl -o json`', () => {
  const line = JSON.stringify({
    __REALTIME_TIMESTAMP: '1795255201123456',
    PRIORITY: '3',
    _SYSTEMD_UNIT: 'backup.service',
    SYSLOG_IDENTIFIER: 'restic',
    MESSAGE: 'Fatal: unable to open repository at sftp://nas.lan/backups',
    _HOSTNAME: 'demo-host',
  });
  assert.deepEqual(parseJournal(line), { t: 1795255201123, level: 'error', unit: 'backup.service', msg: 'Fatal: unable to open repository at sftp://nas.lan/backups' });
  // A user unit, under its manager; a message as bytes; no priority.
  const user = JSON.stringify({ __REALTIME_TIMESTAMP: '1795255202000000', _SYSTEMD_UNIT: 'user@1000.service', _SYSTEMD_USER_UNIT: 'sync.service', MESSAGE: [104, 105, 10] });
  assert.deepEqual(parseJournal(user), { t: 1795255202000, level: 'info', unit: 'sync.service', msg: 'hi' });
  assert.deepEqual(journalNames(user), ['user@1000.service', 'sync.service']);
  assert.equal(parseJournal('-- No entries --'), null);
  assert.deepEqual([0, 3, 4, 5, 6, 7].map(levelFromPriority), ['error', 'error', 'warning', 'notice', 'info', 'debug']);
});

test('plain lines: their own timestamp, level word and syslog program', () => {
  assert.deepEqual(parseText('2026-11-21T09:59:58.500Z ERROR upstream timed out', NOW), { t: NOW - 1500, level: 'error', msg: 'upstream timed out' });
  assert.deepEqual(parseText('2026-11-21 09:59:00,250 [WARN] pool nearly full', NOW, 'info').level, 'warning');
  const sys = parseText('Nov 21 09:58:00 demo-host cron[812]: (root) CMD (run-parts /etc/cron.hourly)', NOW);
  assert.equal(sys.unit, 'cron');
  assert.equal(sys.msg, '(root) CMD (run-parts /etc/cron.hourly)');
  assert.equal(new Date(sys.t).getMonth(), 10);
  assert.deepEqual(parseText('level=error ts=2026-11-21T09:59:00Z msg="disk \\"data\\" is full" path=/srv', NOW), { t: NOW, level: 'error', msg: 'disk "data" is full' });
  assert.deepEqual(parseText('{"level":"warn","time":"2026-11-21T09:59:59Z","msg":"slow query","logger":"db"}', NOW), { t: NOW - 1000, level: 'warning', unit: 'db', msg: 'slow query' });
  assert.equal(parseText('{"level":50,"msg":"boom"}', NOW).level, 'error', 'pino levels');
  assert.equal(parseText('E1121 09:59:00.000 12 main.go:42] lost leader', NOW).level, 'error', 'glog');
  assert.equal(parseText('web | error: cannot bind :80', NOW).level, 'error');
  assert.equal(parseText('GET /error-page.html 200', NOW).level, 'info', 'a word in a path is not a level');
  assert.equal(parseText('the user reported an error in the form', NOW).level, 'info', 'prose is not a level');
  assert.equal(parseText('worker 3 WARN queue lagging', NOW).level, 'warning');
  assert.equal(cleanMessage('\u001b[31mred\u001b[0m  and\ttabs\r'), 'red and tabs');
  assert.equal([...cleanMessage('x'.repeat(1000))].length, 400);
});

test('Docker: multiplexed frames, cut anywhere, and raw TTY streams', () => {
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const all = Buffer.concat([frame(1, '2026-11-21T09:59:59.123456789Z listening on :8080\n'), frame(2, '2026-11-21T10:00:00.000000000Z ERROR db gone\n2026-11-21T10:00:00.5Z retry'), frame(2, 'ing in 5 s\n')]);
  // Fed a few bytes at a time, as a socket may deliver it.
  const d = new DockerDemux();
  const got: { stream: string; line: string }[] = [];
  for (let i = 0; i < all.length; i += 7) got.push(...d.push(all.subarray(i, i + 7)));
  assert.deepEqual(got, [
    { stream: 'stdout', line: '2026-11-21T09:59:59.123456789Z listening on :8080' },
    { stream: 'stderr', line: '2026-11-21T10:00:00.000000000Z ERROR db gone' },
    { stream: 'stderr', line: '2026-11-21T10:00:00.5Z retrying in 5 s' },
  ]);
  assert.deepEqual(splitDockerTimestamp(got[0]!.line), { t: NOW - 877, rest: 'listening on :8080' });
  const tty = new DockerDemux(true);
  assert.deepEqual(tty.push(Buffer.from('one\r\ntw')), [{ stream: 'stdout', line: 'one' }]);
  assert.deepEqual(tty.push(Buffer.from('o\n')), [{ stream: 'stdout', line: 'two' }]);
  // Not told about the TTY: the first bytes aren't a header, so it reads them as text.
  assert.deepEqual(new DockerDemux().push(Buffer.from('plain text line\n')), [{ stream: 'stdout', line: 'plain text line' }]);
});

test('macOS: `log stream --style ndjson`, skipping its header', () => {
  assert.equal(parseMacos('Filtering the log data using "type == 1024"'), null);
  const e = parseMacos(JSON.stringify({ timestamp: '2026-11-21 11:00:00.250000+0100', messageType: 'Fault', eventMessage: 'Disk image could not be mounted', processImagePath: '/usr/libexec/diskimagesiod', subsystem: '' }));
  assert.deepEqual(e, { t: NOW + 250, level: 'error', unit: 'diskimagesiod', msg: 'Disk image could not be mounted' });
  assert.equal(parseMacos(JSON.stringify({ timestamp: '2026-11-21 10:00:00.000000+0000', messageType: 'Default', eventMessage: 'ok', subsystem: 'com.example.sync' }))?.unit, 'com.example.sync');
});

test('Windows: events as PowerShell 5 and 7 write them, one or many', () => {
  const ps5 = JSON.stringify([
    { TimeCreated: '/Date(1795255260000)/', Id: 7031, Level: 2, LevelDisplayName: 'Error', ProviderName: 'Service Control Manager', LogName: 'System', RecordId: 902, Message: 'The Print Spooler service terminated unexpectedly.' },
    { TimeCreated: '/Date(1795255200000)/', Id: 1014, Level: 3, ProviderName: 'DNS Client Events', LogName: 'System', RecordId: 901, Message: 'Name resolution for the name example.test timed out.' },
  ]);
  const ev = parseWindowsEvents(ps5);
  assert.deepEqual(ev.map((e) => [e.t, e.level, e.unit, e.record]), [
    [1795255200000, 'warning', 'DNS Client Events', 901],
    [1795255260000, 'error', 'Service Control Manager', 902],
  ]);
  const ps7 = JSON.stringify({ TimeCreated: '2026-11-21T10:00:00+00:00', Id: 1000, Level: 4, ProviderName: 'Application', LogName: 'Application', RecordId: 5, Message: null });
  assert.deepEqual(parseWindowsEvents(ps7).map((e) => [e.t, e.level, e.msg]), [[NOW, 'info', 'Event 1000']]);
  assert.deepEqual(parseWindowsEvents(''), []);
});

test('Kubernetes and Loki', () => {
  assert.deepEqual(parseKubeLine('[pod/web-7f9c5d-x2x/app] 2026-11-21T09:59:59Z ERROR payment declined: card expired', NOW), { t: NOW - 1000, level: 'error', unit: 'web-7f9c5d-x2x/app', msg: 'payment declined: card expired' });
  const loki = JSON.stringify({ streams: [{ stream: { job: 'nginx', level: 'warn' }, values: [['1795255200000000000', 'upstream slow'], ['1795255199000000000', 'cache miss']] }] });
  assert.deepEqual(parseLokiMessage(loki, NOW), [
    { t: NOW - 1000, level: 'warning', unit: 'nginx', msg: 'cache miss' },
    { t: NOW, level: 'warning', unit: 'nginx', msg: 'upstream slow' },
  ]);
  assert.deepEqual(parseLokiMessage('not json', NOW), []);
});
