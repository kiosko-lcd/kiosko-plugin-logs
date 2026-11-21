/**
 * What a widget does with its sources' data before painting: put every
 * source's lines together, keep the ones its options let through (level,
 * units, message patterns), fold repeats, and count errors per minute.
 */
import { filterPatterns, matchFilter, type Filter } from '@kiosko/sdk';
import { rank, type Level, type LogData, type LogLine, type LogStatus } from './types.ts';

export const SOURCE_IDS = ['logs/journal', 'logs/file', 'logs/docker', 'logs/macos', 'logs/windows', 'logs/kubernetes', 'logs/loki'] as const;

const isData = (v: unknown): v is LogData => !!v && typeof v === 'object' && Array.isArray((v as LogData).lines) && Array.isArray((v as LogData).alerts);

/** Every source's `lines` (or `alerts`), oldest first. */
export function collect(sources: Record<string, unknown>, which: 'lines' | 'alerts'): LogLine[] {
  const out: LogLine[] = [];
  for (const id of SOURCE_IDS) {
    const d = sources[id];
    if (isData(d)) out.push(...d[which]);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The statuses of the sources that report one, by source id. */
export function statuses(sources: Record<string, unknown>): { id: string; status: LogStatus }[] {
  return SOURCE_IDS.flatMap((id) => {
    const d = sources[id];
    return isData(d) && d.status ? [{ id, status: d.status }] : [];
  });
}

/**
 * A message pattern: `/regex/flags` is a regular expression (searched, case
 * folded unless the flags say otherwise); anything else is a glob as in
 * every Kiosko filter, but a pattern without `*` or `?` matches anywhere in
 * the message (`timeout` is `*timeout*`).
 */
function messageTest(pattern: string): ((msg: string) => boolean) | null {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const flags = re[2]!.replace(/[gy]/g, '');
      const r = new RegExp(re[1]!, flags.includes('i') || /[A-Z]/.test(re[1]!) ? flags : `${flags}i`);
      return (msg) => r.test(msg);
    } catch {
      return null;
    }
  }
  const glob = /[*?]/.test(pattern) ? pattern : `*${pattern}*`;
  return (msg) => matchFilter(msg, [glob]);
}

const cache = new Map<string, (msg: string) => boolean>();

/**
 * Whether a message passes the patterns: none (or only exclusions) lets
 * everything else through; `!` leaves out; `/…/` is a regular expression.
 */
export function matchMessage(msg: string, filter: Filter | undefined): boolean {
  const list = filterPatterns(filter);
  if (!list.length) return true;
  const key = JSON.stringify(list);
  let fn = cache.get(key);
  if (!fn) {
    const inc = list.filter((p) => !p.startsWith('!')).map(messageTest).filter((f): f is (m: string) => boolean => !!f);
    const exc = list.filter((p) => p.startsWith('!')).map((p) => messageTest(p.slice(1).trim())).filter((f): f is (m: string) => boolean => !!f);
    fn = (m: string) => !exc.some((f) => f(m)) && (!inc.length || inc.some((f) => f(m)));
    if (cache.size > 200) cache.clear();
    cache.set(key, fn);
  }
  return fn(msg);
}

export interface ViewOptions {
  /** The lowest level shown. */
  level?: Level;
  units?: Filter;
  messages?: Filter;
}

/** The names a line answers to in the `units` filter: `nginx.service` and `journal/nginx.service`. */
export const unitNames = (l: LogLine) => [`${l.kind}/${l.unit}`, l.unit];

/** The lines the options let through. */
export function select(lines: LogLine[], o: ViewOptions): LogLine[] {
  const lowest = o.level ? rank(o.level) : Infinity;
  return lines.filter((l) => rank(l.level) <= lowest && matchFilter(unitNames(l), o.units) && matchMessage(l.msg, o.messages));
}

/** Repeats next to each other (once filtered) folded into one, with their counts added. Oldest first in, oldest first out. */
export function fold(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.msg === l.msg && prev.unit === l.unit && prev.level === l.level && prev.kind === l.kind) {
      out[out.length - 1] = { ...prev, t: Math.max(prev.t, l.t), first: Math.min(prev.first, l.first), count: prev.count + l.count };
    } else out.push(l);
  }
  return out;
}

/**
 * Lines per bucket over the `historyMs` before `now`, oldest bucket first,
 * scaled to lines per minute. A folded group's lines are spread evenly over
 * its span.
 */
export function perMinute(lines: LogLine[], now: number, historyMs: number, buckets: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const span = Math.max(60_000, historyMs);
  const start = now - span;
  const size = span / n;
  const out = new Array<number>(n).fill(0);
  const put = (t: number, c: number) => {
    if (t < start || t > now) return;
    out[Math.min(n - 1, Math.floor((t - start) / size))]! += c;
  };
  for (const l of lines) {
    if (l.count <= 1 || l.t === l.first) put(l.t, l.count);
    else for (let i = 0; i < l.count; i++) put(l.first + ((l.t - l.first) * i) / (l.count - 1), 1);
  }
  const scale = 60_000 / size;
  return out.map((v) => v * scale);
}

/** The newest line of `lines` at `level` or worse, or null. */
export function newest(lines: LogLine[], worst: Level = 'error'): LogLine | null {
  for (let i = lines.length - 1; i >= 0; i--) if (rank(lines[i]!.level) <= rank(worst)) return lines[i]!;
  return null;
}
