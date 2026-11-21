/**
 * Every log's format turned into the same entries: journald's JSON, Docker's
 * multiplexed stream, macOS's ndjson, Windows events as PowerShell's JSON,
 * `kubectl logs --prefix` and Loki's tail messages, plus a reader of plain
 * text lines (timestamps, levels, syslog prefixes, JSON and logfmt lines)
 * for files and containers.
 *
 * All pure: no I/O, so each is tested with fixtures.
 */
import { MAX_MESSAGE, type Level } from './types.ts';

/** A line as read, before masking and buffering. */
export interface Entry {
  t: number;
  level: Level;
  unit: string;
  msg: string;
}

/** journald/syslog priority (0 emerg … 7 debug) as a level. */
export function levelFromPriority(p: number): Level {
  if (!Number.isFinite(p)) return 'info';
  if (p <= 3) return 'error';
  if (p === 4) return 'warning';
  if (p === 5) return 'notice';
  if (p === 6) return 'info';
  return 'debug';
}

/** A level word (`ERROR`, `warn`, `E`, `fatal`, `information`…) as a level, or null. */
export function levelFromWord(w: string | undefined | null): Level | null {
  if (!w) return null;
  const s = String(w).trim().toLowerCase();
  if (/^(e|err|error|errors|fatal|f|crit|critical|panic|emerg|emergency|alert|severe|failure|fault|c)$/.test(s)) return 'error';
  if (/^(w|warn|warning|warnings)$/.test(s)) return 'warning';
  if (/^(n|notice)$/.test(s)) return 'notice';
  if (/^(i|info|information|informational|default|log)$/.test(s)) return 'info';
  if (/^(d|debug|trace|t|verbose|v|fine|finer|finest|dbg)$/.test(s)) return 'debug';
  return null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One clean line: no colour codes nor control characters, spaces collapsed, at most `MAX_MESSAGE` characters. */
export function cleanMessage(s: string): string {
  const one = s.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (one.length <= MAX_MESSAGE) return one;
  return `${[...one].slice(0, MAX_MESSAGE - 1).join('')}…`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A timestamp a line may start with, parsed, and how long it was. */
function leadingTime(s: string, now: number): { t: number; len: number } | null {
  // 2026-11-21T10:00:01.123Z, 2026-11-21 10:00:01,123 +0100, [2026-11-21 10:00:01]
  const iso = /^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?\s?(Z|[+-]\d{2}:?\d{2})?\]?\s*/.exec(s);
  if (iso) {
    const frac = iso[3] ? `.${iso[3].slice(0, 3).padEnd(3, '0')}` : '';
    const zone = iso[4] ? (iso[4] === 'Z' ? 'Z' : iso[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '';
    const t = Date.parse(`${iso[1]}T${iso[2]}${frac}${zone}`);
    if (Number.isFinite(t)) return { t, len: iso[0].length };
  }
  // Syslog: "Nov 21 10:00:01 " (the year is this one, or last year's for a December line read in January).
  const sys = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\s+/.exec(s);
  if (sys) {
    const m = MONTHS.indexOf(sys[1]!.toLowerCase());
    if (m >= 0) {
      const year = new Date(now).getFullYear();
      let t = new Date(year, m, Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5])).getTime();
      if (t - now > 2 * 86_400_000) t = new Date(year - 1, m, Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5])).getTime();
      return { t, len: sys[0].length };
    }
  }
  return null;
}

/** Fields of a JSON log line, under the names loggers use. */
function fromJsonLine(o: Record<string, unknown>): { t?: number; level?: Level; unit?: string; msg?: string } | null {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return undefined;
  };
  const msg = pick('msg', 'message', 'MESSAGE', 'log', 'text', 'event');
  if (msg === undefined) return null;
  const lv = pick('level', 'lvl', 'severity', 'loglevel', 'log.level', 'levelname', 'status');
  const level = typeof lv === 'number' ? (lv >= 50 ? 'error' : lv >= 40 ? 'warning' : lv >= 30 ? 'info' : 'debug') : levelFromWord(lv as string);
  const ts = pick('time', 'ts', 'timestamp', '@timestamp', 'datetime', 'date');
  let t: number | undefined;
  if (typeof ts === 'number') t = ts > 1e12 ? ts : ts * 1000;
  else if (typeof ts === 'string') {
    const p = Date.parse(ts);
    if (Number.isFinite(p)) t = p;
  }
  const unit = pick('logger', 'name', 'service', 'component', 'module');
  return { ...(t !== undefined ? { t } : {}), ...(level ? { level } : {}), ...(typeof unit === 'string' ? { unit } : {}), msg: typeof msg === 'string' ? msg : JSON.stringify(msg) };
}

const LV = 'emerg|emergency|alert|crit|critical|fatal|panic|severe|error|err|warning|warn|notice|info|debug|trace';
const FIRST_WORD = new RegExp(String.raw`^(?:[\w.-]+\s+\|\s+)?[[(<]?(${LV})\b[\])>]?:?\s`, 'i');
const LATER_WORD = new RegExp(String.raw`^(?:\S+\s+){1,4}?(?:\[(${LV})\]|<(${LV})>|(${LV}):\s|(${LV.toUpperCase()})\b)`, 'i');

/**
 * A plain text line read: its own timestamp (else `now`), its level (a word
 * near the start: `ERROR`, `[warn]`, `level=error`, `E1121`; else `fallback`)
 * and, for syslog lines, the program as the unit. JSON and logfmt lines give
 * their message.
 */
export function parseText(line: string, now: number, fallback: Level = 'info'): { t: number; level: Level; unit?: string; msg: string } {
  let s = line.replace(ANSI, '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const j = fromJsonLine(JSON.parse(s) as Record<string, unknown>);
      if (j?.msg !== undefined) return { t: j.t ?? now, level: j.level ?? fallback, ...(j.unit ? { unit: j.unit } : {}), msg: cleanMessage(j.msg) };
    } catch {
      /* not JSON after all */
    }
  }
  let t = now;
  let unit: string | undefined;
  const lead = leadingTime(s, now);
  if (lead) {
    t = lead.t;
    s = s.slice(lead.len);
    // Syslog: "host program[123]: message"
    const prog = /^\S+ ([\w./@-]+?)(?:\[\d+\])?: /.exec(s);
    if (prog && !levelFromWord(prog[1])) {
      unit = prog[1];
      s = s.slice(prog[0].length);
    }
  }
  // logfmt: level=error msg="…"
  const lf = /(?:^|\s)(?:level|lvl|severity)=("?)(\w+)\1/.exec(s);
  let level = lf ? levelFromWord(lf[2]) : null;
  if (lf) {
    const m = /(?:^|\s)(?:msg|message)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(s);
    if (m) s = (m[1] ?? m[2] ?? s).replace(/\\"/g, '"');
  }
  if (!level) {
    // A level word: first ("error: …", "[warn] …", "web | ERROR …"), or among the first few
    // words when it can't be prose: upper-case ("… INFO …"), bracketed ("[error]") or with a colon.
    const first = FIRST_WORD.exec(`${s} `);
    const later = first ?? LATER_WORD.exec(s);
    const upper = later && !first && later[4] && later[4] !== later[4].toUpperCase() ? null : later;
    const word = upper ? (upper[1] ?? upper[2] ?? upper[3] ?? upper[4]) : undefined;
    if (word) level = levelFromWord(word);
    // The colour says the level: a leading "ERROR " / "[warn] " needn't be painted too.
    if (first && level && !/\|/.test(first[0])) s = s.slice(Math.min(s.length, first[0].length));
    else {
      const glog = /^([EWIF])\d{4} \d{2}:\d{2}:\d{2}/.exec(s);
      if (glog) level = levelFromWord(glog[1] === 'F' ? 'fatal' : glog[1]);
    }
  }
  return { t, level: level ?? fallback, ...(unit ? { unit } : {}), msg: cleanMessage(s) };
}

/* journald ---------------------------------------------------------------- */

/** journald fields are text, or arrays of bytes when they aren't valid UTF-8. */
function journalText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return Buffer.from(v as number[]).toString('utf8');
  return undefined;
}

/** One line of `journalctl -o json`: the entry, the names its unit goes by (for the filter) and its cursor. */
export function parseJournalRecord(line: string): { entry: Entry; names: string[]; cursor?: string } | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const msg = journalText(o.MESSAGE);
  if (msg === undefined) return null;
  const us = Number(o.__REALTIME_TIMESTAMP);
  const t = Number.isFinite(us) ? Math.round(us / 1000) : Date.now();
  const sysUnit = journalText(o._SYSTEMD_UNIT);
  const userUnit = journalText(o._SYSTEMD_USER_UNIT);
  const ident = journalText(o.SYSLOG_IDENTIFIER);
  const unit = userUnit ?? sysUnit ?? ident ?? journalText(o._COMM) ?? (o._TRANSPORT === 'kernel' ? 'kernel' : 'journal');
  // A user unit's manager is user@1000.service: the program inside it says more.
  const shown = unit === sysUnit && /^user@\d+\.service$/.test(unit) ? (ident ?? unit) : unit;
  const prio = Number(journalText(o.PRIORITY) ?? 6);
  const cursor = journalText(o.__CURSOR);
  return {
    entry: { t, level: levelFromPriority(prio), unit: shown, msg: cleanMessage(msg) },
    names: [sysUnit, userUnit, ident].filter((x): x is string => !!x),
    ...(cursor ? { cursor } : {}),
  };
}

/** One line of `journalctl -o json` as an entry, or null if it isn't one. */
export function parseJournal(line: string): Entry | null {
  return parseJournalRecord(line)?.entry ?? null;
}

/** The unit names of a journal line, for the filter: the unit, the user unit and the identifier. */
export function journalNames(line: string): string[] {
  return parseJournalRecord(line)?.names ?? [];
}

/* Docker -------------------------------------------------------------------- */

/**
 * Docker's log stream for a container without a TTY: frames of an 8-byte
 * header (stream 1 = stdout, 2 = stderr; then 3 zero bytes; then the payload
 * length, big-endian) and the payload. Feed it chunks as they come; frames
 * cut across chunks are put back together. A container with a TTY sends
 * plain bytes: `raw: true`.
 */
export class DockerDemux {
  private buf: Buffer = Buffer.alloc(0);
  private text: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private raw: boolean;
  constructor(raw = false) {
    this.raw = raw;
  }

  /** Complete lines found in `chunk` (and what was pending), in order. */
  push(chunk: Buffer): { stream: 'stdout' | 'stderr'; line: string }[] {
    const out: { stream: 'stdout' | 'stderr'; line: string }[] = [];
    if (this.raw) {
      this.lines('stdout', chunk.toString('utf8'), out);
      return out;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const kind = this.buf[0]!;
      const size = this.buf.readUInt32BE(4);
      if (kind > 2 || this.buf[1] !== 0 || this.buf[2] !== 0 || this.buf[3] !== 0) {
        // Not a frame header: this stream is raw after all (a TTY we weren't told about).
        const rest = this.buf;
        this.buf = Buffer.alloc(0);
        this.raw = true;
        this.lines('stdout', rest.toString('utf8'), out);
        return out;
      }
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size).toString('utf8');
      this.buf = this.buf.subarray(8 + size);
      this.lines(kind === 2 ? 'stderr' : 'stdout', payload, out);
    }
    return out;
  }

  private lines(stream: 'stdout' | 'stderr', text: string, out: { stream: 'stdout' | 'stderr'; line: string }[]): void {
    const parts = (this.text[stream] + text).split(/\r?\n/);
    this.text[stream] = parts.pop() ?? '';
    // A line longer than 64 KB without an end is kept as it is.
    if (this.text[stream].length > 65_536) {
      parts.push(this.text[stream]);
      this.text[stream] = '';
    }
    for (const p of parts) if (p.trim()) out.push({ stream, line: p });
  }
}

/** A line of Docker's logs with `timestamps=1`: `2026-11-21T10:00:01.123456789Z message`. */
export function splitDockerTimestamp(line: string): { t: number | null; rest: string } {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}) /.exec(line);
  if (!m) return { t: null, rest: line };
  const t = Date.parse(`${m[1]}${(m[2] ?? '').slice(0, 4)}${m[3]}`);
  return { t: Number.isFinite(t) ? t : null, rest: line.slice(m[0].length) };
}

/* macOS ------------------------------------------------------------------------- */

/** One line of `log stream --style ndjson`, or null (the "Filtering the log data…" header, a blank). */
export function parseMacos(line: string): Entry | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o.eventMessage !== 'string') return null;
  // "2026-11-21 10:00:01.123456+0100"
  const ts = typeof o.timestamp === 'string' ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(\d{2})$/.exec(o.timestamp) : null;
  const t = ts ? Date.parse(`${ts[1]}T${ts[2]}${(ts[3] ?? '').slice(0, 4)}${ts[4]}:${ts[5]}`) : Date.now();
  const type = String(o.messageType ?? '').toLowerCase();
  const level: Level = type === 'fault' || type === 'error' ? 'error' : type === 'debug' ? 'debug' : 'info';
  const image = typeof o.processImagePath === 'string' ? o.processImagePath.split('/').pop() : undefined;
  const unit = (typeof o.subsystem === 'string' && o.subsystem) || image || 'log';
  return { t: Number.isFinite(t) ? t : Date.now(), level, unit, msg: cleanMessage(o.eventMessage) };
}

/* Windows ------------------------------------------------------------------------- */

/** A Windows event as `Get-WinEvent | Select … | ConvertTo-Json` writes it. */
export interface WinEvent extends Entry {
  log: string;
  record: number;
}

/** `/Date(1763719201000)/` (Windows PowerShell 5) or an ISO date (PowerShell 7). */
function winTime(v: unknown): number {
  if (typeof v === 'string') {
    const m = /\/Date\((-?\d+)/.exec(v);
    if (m) return Number(m[1]);
    const p = Date.parse(v);
    if (Number.isFinite(p)) return p;
  }
  if (v && typeof v === 'object' && 'value' in v) return winTime((v as { value: unknown }).value);
  return Date.now();
}

/** Events in PowerShell's JSON (one object, or an array of them), oldest first. */
export function parseWindowsEvents(json: string): WinEvent[] {
  const text = json.trim();
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  const out: WinEvent[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    // Level: 1 critical, 2 error, 3 warning, 4 information, 0 "log always", 5 verbose.
    const lv = Number(o.Level);
    const level: Level = lv === 1 || lv === 2 ? 'error' : lv === 3 ? 'warning' : lv === 5 ? 'debug' : 'info';
    const msg = typeof o.Message === 'string' && o.Message.trim() ? o.Message : `Event ${o.Id ?? '?'}`;
    out.push({ t: winTime(o.TimeCreated), level, unit: String(o.ProviderName ?? o.LogName ?? 'Windows'), msg: cleanMessage(msg), log: String(o.LogName ?? ''), record: Number(o.RecordId ?? 0) });
  }
  return out.sort((a, b) => a.t - b.t || a.record - b.record);
}

/* Kubernetes ------------------------------------------------------------------------- */

/** A line of `kubectl logs --prefix --timestamps`: `[pod/web-7f9c/app] 2026-11-21T10:00:01.123Z message`. */
export function parseKubeLine(line: string, now: number): Entry {
  let rest = line;
  let unit = 'kubernetes';
  const p = /^\[([^\]]+)\] /.exec(rest);
  if (p) {
    // pod/web-7f9c5d-x2x/app → web-7f9c5d-x2x/app
    unit = p[1]!.replace(/^pod\//, '');
    rest = rest.slice(p[0].length);
  }
  const ts = splitDockerTimestamp(rest);
  const r = parseText(ts.rest, ts.t ?? now);
  return { t: ts.t ?? r.t, level: r.level, unit, msg: r.msg };
}

/* Loki ---------------------------------------------------------------------------------- */

/** The entries of one message of Loki's `/loki/api/v1/tail`, oldest first. */
export function parseLokiMessage(json: string, now: number): Entry[] {
  let v: { streams?: { stream?: Record<string, string>; values?: [string, string][] }[] };
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const s of v.streams ?? []) {
    const labels = s.stream ?? {};
    const unit = labels.service_name ?? labels.app ?? labels.container ?? labels.unit ?? labels.job ?? labels.filename?.split('/').pop() ?? 'loki';
    const labelled = levelFromWord(labels.level ?? labels.detected_level ?? labels.severity);
    for (const [ns, text] of s.values ?? []) {
      const t = Math.round(Number(ns) / 1e6);
      const r = parseText(String(text), Number.isFinite(t) ? t : now);
      out.push({ t: Number.isFinite(t) ? t : r.t, level: labelled ?? r.level, unit: r.unit ?? unit, msg: r.msg });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
