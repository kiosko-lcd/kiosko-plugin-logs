/**
 * The followers of every log, each a function that runs until the signal
 * aborts, handing entries to `add` and how it goes to `status`. The sources
 * (sources.ts) wire them to a buffer and to Kiosko; `supervise` restarts
 * them when they die.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { matchFilter, type Filter } from '@kiosko/sdk';
import { dockerStream, hasTty, listContainers, logsPath, type Container } from './docker.ts';
import { followFile } from './follow-file.ts';
import { DockerDemux, parseJournalRecord, parseKubeLine, parseLokiMessage, parseMacos, parseText, parseWindowsEvents, splitDockerTimestamp, type Entry } from './parse.ts';
import { sleep, spawnLines, supervise } from './supervise.ts';
import type { Level, LogStatus } from './types.ts';

export interface Hooks {
  signal: AbortSignal;
  add: (e: Entry) => void;
  status: (s: LogStatus) => void;
  log: (msg: string) => void;
}

/** journalctl's `-p` for the lowest level wanted. */
const PRIORITY: Record<Level, number> = { error: 3, warning: 4, notice: 5, info: 6, debug: 7 };

/* journald ------------------------------------------------------------------------------- */

export interface JournalOptions {
  units: Filter;
  priority: Level;
  onlyUser: boolean;
  bin: string;
}

/** journalctl's arguments: the last 200 lines and on; after a restart, from where it left off (`cursor`). */
export function journalArgs(o: Pick<JournalOptions, 'priority' | 'onlyUser'>, cursor?: string): string[] {
  return ['--follow', '--output=json', cursor ? `--after-cursor=${cursor}` : '--lines=200', `--priority=${PRIORITY[o.priority] ?? 6}`, '--no-pager', '--quiet', ...(o.onlyUser ? ['--user'] : [])];
}

export function followJournal(o: JournalOptions, h: Hooks): Promise<void> {
  const bin = o.bin.trim() || 'journalctl';
  let cursor: string | undefined;
  return supervise(
    (signal) =>
      spawnLines(bin, journalArgs(o, cursor), {
        signal,
        onStart: () => h.status({ state: 'following' }),
        onLine: (line) => {
          const r = parseJournalRecord(line);
          if (!r) return;
          if (r.cursor) cursor = r.cursor;
          if (!matchFilter([...r.names, r.entry.unit], o.units)) return;
          h.add(r.entry);
        },
      }),
    { signal: h.signal, status: h.status, log: h.log },
  );
}

/* files ------------------------------------------------------------------------------------ */

export function followFiles(paths: string[], h: Hooks): Promise<void> {
  const states = new Map<string, LogStatus>();
  // One status for all: following if any is, else the first problem.
  const report = () => {
    const all = [...states.values()];
    const ok = all.filter((s) => s.state === 'following').length;
    const bad = all.find((s) => s.state !== 'following');
    h.status(ok ? { state: 'following', ...(bad ? { message: bad.message } : {}) } : (bad ?? { state: 'waiting' }));
  };
  return Promise.all(
    paths.map((path) => {
      const unit = basename(path);
      const status = (s: LogStatus) => {
        states.set(path, s);
        report();
      };
      return supervise(
        (signal) =>
          followFile(path, {
            signal,
            status,
            onLine: (line) => {
              const e = parseText(line, Date.now());
              h.add({ t: e.t, level: e.level, unit: e.unit ?? unit, msg: e.msg });
            },
          }),
        { signal: h.signal, status, log: (m) => h.log(`${unit}: ${m}`) },
      );
    }),
  ).then(() => undefined);
}

/* Docker ------------------------------------------------------------------------------------ */

export interface DockerOptions {
  containers: Filter;
  socket: string;
}

const containerNames = (c: Container) => [c.name, ...(c.service ? [c.service] : []), ...(c.project && c.service ? [`${c.project}/${c.service}`] : [])];

/** Follows the running containers the filter picks, looking for new ones every `rescanMs`. */
export function followDocker(o: DockerOptions, h: Hooks, rescanMs = 15_000): Promise<void> {
  const followed = new Map<string, AbortController>();
  const lastSeen = new Map<string, number>();
  const followOne = async (c: Container, signal: AbortSignal) => {
    const tty = await hasTty(o.socket, c.id, signal);
    const demux = new DockerDemux(tty);
    const since = lastSeen.get(c.id);
    await dockerStream(o.socket, logsPath(c.id, since ? { tail: 0, since } : { tail: 50 }), signal, (chunk) => {
      for (const { line } of demux.push(chunk)) {
        const { t, rest } = splitDockerTimestamp(line);
        if (since && t !== null && t <= since) continue;
        const e = parseText(rest, t ?? Date.now());
        if (t !== null) lastSeen.set(c.id, Math.max(lastSeen.get(c.id) ?? 0, t));
        h.add({ t: t ?? e.t, level: e.level, unit: c.name, msg: e.msg });
      }
    });
  };
  return supervise(
    async (signal) => {
      try {
        while (!signal.aborted) {
          const running = (await listContainers(o.socket, signal)).filter((c) => matchFilter(containerNames(c), o.containers));
          const ids = new Set(running.map((c) => c.id));
          for (const [id, ac] of followed) if (!ids.has(id)) (ac.abort(), followed.delete(id));
          for (const c of running) {
            if (followed.has(c.id)) continue;
            const ac = new AbortController();
            followed.set(c.id, ac);
            const s = AbortSignal.any([signal, ac.signal]);
            followOne(c, s)
              .catch((err) => !s.aborted && h.log(`${c.name}: ${err instanceof Error ? err.message : err}`))
              .finally(() => followed.get(c.id) === ac && followed.delete(c.id));
          }
          h.status(running.length ? { state: 'following' } : { state: 'waiting', message: 'Docker: no running container matches' });
          await sleep(rescanMs, signal);
        }
      } finally {
        for (const ac of followed.values()) ac.abort();
        followed.clear();
      }
    },
    { signal: h.signal, status: h.status, log: h.log },
  );
}

/* macOS ------------------------------------------------------------------------------------- */

export interface MacosOptions {
  predicate: string;
  level: 'default' | 'info' | 'debug';
  bin: string;
}

export function macosArgs(o: Pick<MacosOptions, 'predicate' | 'level'>): string[] {
  return ['stream', '--style', 'ndjson', '--level', o.level, ...(o.predicate.trim() ? ['--predicate', o.predicate.trim()] : [])];
}

export function followMacos(o: MacosOptions, h: Hooks): Promise<void> {
  return supervise(
    (signal) =>
      spawnLines(o.bin.trim() || '/usr/bin/log', macosArgs(o), {
        signal,
        onStart: () => h.status({ state: 'following' }),
        onLine: (line) => {
          const e = parseMacos(line);
          if (e) h.add(e);
        },
      }),
    { signal: h.signal, status: h.status, log: h.log },
  );
}

/* Windows ------------------------------------------------------------------------------------- */

export interface WindowsOptions {
  logs: string[];
  priority: 'error' | 'warning' | 'info';
  bin: string;
}

/** Get-WinEvent's levels for the lowest one wanted: 1 critical, 2 error, 3 warning, 4 and 0 information. */
const WIN_LEVELS = { error: [1, 2], warning: [1, 2, 3], info: [0, 1, 2, 3, 4] } as const;

/** The PowerShell that reads the events since `since` (ms), as JSON. Quotes doubled: a log name can't break out. */
export function windowsScript(o: Pick<WindowsOptions, 'logs' | 'priority'>, since: number, max = 200): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const logs = (o.logs.length ? o.logs : ['System', 'Application']).map(q).join(',');
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$f=@{LogName=@(${logs});Level=@(${WIN_LEVELS[o.priority].join(',')});StartTime=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(since)}).LocalDateTime}`,
    `Get-WinEvent -FilterHashtable $f -MaxEvents ${max} | Select-Object TimeCreated,Id,Level,ProviderName,LogName,RecordId,Message | ConvertTo-Json -Compress -Depth 2`,
  ].join('; ');
}

/** Asks for new events every `pollMs`: Windows has no `-f`. */
export function followWindows(o: WindowsOptions, h: Hooks, pollMs = 15_000): Promise<void> {
  const bin = o.bin.trim() || 'powershell.exe';
  const seen = new Set<string>();
  let since = Date.now() - 60 * 60_000;
  const poll = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const script = Buffer.from(windowsScript(o, since - 2000), 'utf16le').toString('base64');
      execFile(bin, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { signal, windowsHide: true, maxBuffer: 16 << 20, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${bin}: not found`));
        if (err && !stdout) return reject(new Error(`${bin}: ${String(stderr || err.message).trim().split(/\r?\n/).pop()}`));
        resolve(stdout);
      });
    });
  return supervise(
    async (signal) => {
      while (!signal.aborted) {
        const events = parseWindowsEvents(await poll(signal));
        h.status({ state: 'following' });
        for (const e of events) {
          const key = `${e.log}:${e.record}`;
          if (seen.has(key)) continue;
          seen.add(key);
          since = Math.max(since, e.t);
          h.add(e);
        }
        if (seen.size > 5000) seen.clear();
        await sleep(pollMs, signal);
      }
    },
    { signal: h.signal, status: h.status, log: h.log },
  );
}

/* Kubernetes ------------------------------------------------------------------------------------ */

export interface KubeOptions {
  selector: string;
  namespace: string;
  context: string;
  bin: string;
}

/** `kubectl logs` for a label selector (`app=web`) or a resource (`deployment/web`, a pod's name). */
export function kubeArgs(o: Omit<KubeOptions, 'bin'>, since?: number): string[] {
  const sel = o.selector.trim();
  return [
    'logs',
    '--follow',
    '--timestamps',
    '--prefix',
    '--all-containers',
    '--max-log-requests=20',
    since ? `--since-time=${new Date(since).toISOString()}` : '--tail=50',
    ...(o.namespace.trim() ? ['--namespace', o.namespace.trim()] : []),
    ...(o.context.trim() ? ['--context', o.context.trim()] : []),
    ...(sel.includes('=') ? ['--selector', sel] : [sel]),
  ];
}

export function followKube(o: KubeOptions, h: Hooks): Promise<void> {
  let last = 0;
  return supervise(
    (signal) => {
      const since = last;
      return spawnLines(o.bin.trim() || 'kubectl', kubeArgs(o, since || undefined), {
        signal,
        onStart: () => h.status({ state: 'following' }),
        onLine: (line) => {
          const e = parseKubeLine(line, Date.now());
          if (since && e.t <= since) return;
          last = Math.max(last, e.t);
          h.add(e);
        },
      });
    },
    { signal: h.signal, status: h.status, log: h.log },
  );
}

/* Loki ------------------------------------------------------------------------------------------- */

export interface LokiOptions {
  url: string;
  query: string;
  token: string;
  orgId: string;
}

/** The tail socket's address and headers; user:password in the URL become a Basic header. */
export function lokiTail(o: LokiOptions, since?: number): { url: string; headers: Record<string, string> } {
  const u = new URL(o.url.trim().replace(/\/+$/, '') + '/loki/api/v1/tail');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const headers: Record<string, string> = {};
  if (u.username) headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
  u.username = '';
  u.password = '';
  if (o.token.trim()) headers.Authorization = `Bearer ${o.token.trim()}`;
  if (o.orgId.trim()) headers['X-Scope-OrgID'] = o.orgId.trim();
  u.searchParams.set('query', o.query.trim());
  u.searchParams.set('limit', '100');
  if (since) u.searchParams.set('start', `${Math.floor(since) + 1}000000`);
  return { url: u.href, headers };
}

export function followLoki(o: LokiOptions, h: Hooks): Promise<void> {
  let last = 0;
  return supervise(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const { url, headers } = lokiTail(o, last || undefined);
        const WS = (globalThis as { WebSocket?: new (url: string, init?: unknown) => WebSocket }).WebSocket;
        if (!WS) return reject(new Error('Loki: this Node has no WebSocket (22 or later needed)'));
        const ws = new WS(url, { headers });
        let opened = false;
        const stop = () => ws.close();
        signal.addEventListener('abort', stop, { once: true });
        ws.onopen = () => {
          opened = true;
          h.status({ state: 'following' });
        };
        ws.onmessage = (ev: MessageEvent) => {
          for (const e of parseLokiMessage(String(ev.data), Date.now())) {
            last = Math.max(last, e.t);
            h.add(e);
          }
        };
        ws.onerror = () => undefined;
        ws.onclose = (ev: CloseEvent) => {
          signal.removeEventListener('abort', stop);
          if (signal.aborted) return resolve();
          reject(new Error(opened ? `Loki: closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})` : `Loki: cannot connect to ${new URL(o.url).host}`));
        };
      }),
    { signal: h.signal, status: h.status, log: h.log },
  );
}
