/**
 * Followers die: journalctl is restarted by an update, a container stops,
 * the Docker daemon goes away, the network drops a Loki socket. `supervise`
 * starts a follower again, waiting longer each time it fails (1 s, 2 s, 4 s…
 * up to a minute) and again 1 s once one has run well for a minute. It stops
 * for good when the source's signal aborts.
 */
import { spawn } from 'node:child_process';
import type { LogStatus } from './types.ts';

export interface SuperviseOptions {
  signal: AbortSignal;
  /** Told how the following goes: `following` when started, `error` with why when it died. */
  status: (s: LogStatus) => void;
  log?: (msg: string) => void;
  minMs?: number;
  maxMs?: number;
  /** A follower that ran this long was fine: the next wait starts again at `minMs`. */
  healthyMs?: number;
  clock?: () => number;
}

/** Waits `ms`, or less if `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Runs `follow` again and again until `signal` aborts. `follow` returns (or
 * throws) when its follower is gone; what it throws is the status message.
 */
export async function supervise(follow: (signal: AbortSignal) => Promise<void>, o: SuperviseOptions): Promise<void> {
  const min = o.minMs ?? 1000;
  const max = o.maxMs ?? 60_000;
  const healthy = o.healthyMs ?? 60_000;
  const clock = o.clock ?? Date.now;
  let wait = min;
  while (!o.signal.aborted) {
    const started = clock();
    let why: string;
    try {
      await follow(o.signal);
      why = 'stopped';
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    if (o.signal.aborted) return;
    if (clock() - started >= healthy) wait = min;
    o.status({ state: 'error', message: why });
    o.log?.(`${why}; again in ${Math.round(wait / 1000)} s`);
    await sleep(wait, o.signal);
    wait = Math.min(max, wait * 2);
  }
}

/** Why a program couldn't run, in words. */
function spawnError(cmd: string, err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT') return new Error(`${cmd}: not found`);
  if (err.code === 'EACCES') return new Error(`${cmd}: permission denied`);
  return new Error(`${cmd}: ${err.message}`);
}

/**
 * Runs `cmd` and hands every line of its output to `onLine` as it comes.
 * Resolves when it exits; rejects, with the last thing it said on stderr,
 * when it exits with an error or can't start. Killed when `signal` aborts.
 */
export function spawnLines(cmd: string, args: string[], o: { signal: AbortSignal; onLine: (line: string) => void; onStart?: () => void; env?: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return resolve();
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: o.signal, env: o.env ?? process.env });
    } catch (err) {
      return reject(spawnError(cmd, err as NodeJS.ErrnoException));
    }
    let pending = '';
    let said = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.on('spawn', () => o.onStart?.());
    child.stdout.on('data', (chunk: string) => {
      const parts = (pending + chunk).split(/\r?\n/);
      pending = parts.pop() ?? '';
      if (pending.length > 1 << 20) pending = '';
      for (const p of parts) if (p) o.onLine(p);
    });
    child.stderr.on('data', (chunk: string) => {
      said = (said + chunk).slice(-600);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') return resolve();
      reject(spawnError(cmd, err));
    });
    child.on('close', (code, sig) => {
      if (pending) o.onLine(pending);
      if (o.signal.aborted) return resolve();
      const last = said.trim().split(/\r?\n/).pop()?.trim();
      if (code === 0) return reject(new Error(`${cmd} exited${last ? `: ${last}` : ''}`));
      reject(new Error(`${cmd} ${sig ? `was killed (${sig})` : `failed (${code})`}${last ? `: ${last}` : ''}`));
    });
  });
}
