/**
 * Invented logs for the gallery, the editor, the tests and the screenshots:
 * a small home server (a web shop, its database, a nightly backup, a few
 * containers). Nothing here was ever read from a real machine; the lines
 * that look like they carry a secret are made up too, and go through the
 * same masking as real ones, so the pictures show what masking looks like.
 */
import { LogBuffer } from './buffer.ts';
import type { Entry } from './parse.ts';
import type { Kind, Level, LogData } from './types.ts';

type Line = [secondsAgo: number, level: Level, unit: string, msg: string];

const JOURNAL: Line[] = [
  [3300, 'info', 'backup.service', 'Starting nightly backup of /srv/shop'],
  [3290, 'error', 'backup.service', 'Fatal: unable to open repository at sftp://backup:Winter2026@nas.example.lan/shop: connection refused'],
  [3289, 'warning', 'backup.service', 'backup.service: Failed with result \'exit-code\'.'],
  [2400, 'info', 'certbot.service', 'Certificate for shop.example.com is not due for renewal'],
  [1500, 'notice', 'sshd', 'Accepted publickey for deploy from 192.0.2.44 port 52814'],
  [1260, 'warning', 'postgresql', 'checkpoints are occurring too frequently (24 seconds apart)'],
  [1200, 'error', 'nginx.service', 'upstream timed out (110: Connection timed out) while reading response header from upstream'],
  [610, 'info', 'cron', '(root) CMD (/usr/local/bin/rotate-thumbnails)'],
  [420, 'warning', 'smartd', 'Device: /dev/sda [SAT], 8 Currently unreadable (pending) sectors'],
  [300, 'info', 'nginx.service', 'POST /api/hooks/stock?token=demo-abc123 401'],
  [180, 'notice', 'systemd', 'Started shop-worker.service - Shop background jobs.'],
  [95, 'info', 'shop-worker', 'Password reset mail queued for ana.garcia@example.com'],
  [64, 'debug', 'shop-worker', 'cache warmed: 1 240 products in 3.1 s'],
];

/** The burst: the same timeout again and again for a couple of minutes. */
const BURST: { from: number; to: number; every: number; line: [Level, string, string] } = { from: 150, to: 6, every: 4, line: ['error', 'nginx.service', 'upstream timed out (110: Connection timed out) while reading response header from upstream'] };

const DOCKER: Line[] = [
  [900, 'info', 'shop-web', 'Listening on http://0.0.0.0:8080'],
  [700, 'warning', 'shop-worker', 'Job 4711 took 38 s (limit 30 s)'],
  [520, 'info', 'redis', 'Background saving terminated with success'],
  [240, 'error', 'shop-worker', 'PaymentGatewayError: card_declined for order 10234'],
  [40, 'info', 'shop-web', 'GET /products/blue-mug 200 12 ms'],
  [12, 'info', 'shop-web', 'GET /cart 200 8 ms'],
];

const FILE: Line[] = [
  [1800, 'info', 'shop.log', 'Imported 312 products from supplier feed'],
  [880, 'warning', 'shop.log', 'Supplier feed answered in 9.8 s'],
  [30, 'info', 'shop.log', 'Order 10235 paid (3 items)'],
];

const MACOS: Line[] = [
  [600, 'info', 'com.apple.TimeMachine', 'Backup completed successfully'],
  [200, 'error', 'diskarbitrationd', 'Unable to mount disk "Photos 2019": the disk is damaged'],
  [20, 'info', 'com.apple.wifi', 'Joined network "Home"'],
];

const WINDOWS: Line[] = [
  [1200, 'warning', 'DNS Client Events', 'Name resolution for the name printer.example.lan timed out'],
  [400, 'error', 'Service Control Manager', 'The Print Spooler service terminated unexpectedly'],
  [60, 'info', 'Microsoft-Windows-WindowsUpdateClient', 'Installation successful: Security update for Windows'],
];

const KUBE: Line[] = [
  [500, 'info', 'shop-api-6d9f/api', 'ready in 2.3 s'],
  [90, 'warning', 'shop-api-6d9f/api', 'slow request GET /search 1.9 s'],
];

/** Errors spread over the hour before: a quiet line with one bad spell, for the curve. */
function scattered(now: number): Entry[] {
  const out: Entry[] = [];
  for (let m = 60; m >= 1; m--) {
    // A deterministic pattern: mostly 0–1 a minute, a spike 18–22 min ago.
    const n = m >= 18 && m <= 22 ? 6 + ((m * 7) % 5) : (m * 13) % 11 === 0 ? 2 : (m * 5) % 7 === 0 ? 1 : 0;
    for (let i = 0; i < n; i++) out.push({ t: now - m * 60_000 + i * 5000, level: 'error', unit: 'nginx.service', msg: 'upstream timed out (110: Connection timed out) while reading response header from upstream' });
    if ((m * 3) % 8 === 0) out.push({ t: now - m * 60_000 + 30_000, level: 'warning', unit: 'postgresql', msg: 'checkpoints are occurring too frequently (24 seconds apart)' });
  }
  return out;
}

const SETS: Partial<Record<Kind, Line[]>> = { journal: JOURNAL, docker: DOCKER, file: FILE, macos: MACOS, windows: WINDOWS, kubernetes: KUBE };

/** A source's demo data at `now`. */
export function demoData(kind: Kind, now: number): LogData {
  const buf = new LogBuffer(kind);
  const entries: Entry[] = (SETS[kind] ?? []).map(([ago, level, unit, msg]) => ({ t: now - ago * 1000, level, unit, msg }));
  if (kind === 'journal') {
    entries.push(...scattered(now));
    for (let s = BURST.from; s >= BURST.to; s -= BURST.every) entries.push({ t: now - s * 1000, level: BURST.line[0], unit: BURST.line[1], msg: BURST.line[2] });
  }
  for (const e of entries.sort((a, b) => a.t - b.t)) buf.add(e);
  return buf.snapshot({ state: 'following' });
}
