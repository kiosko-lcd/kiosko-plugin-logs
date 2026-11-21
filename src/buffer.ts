/**
 * What a source keeps between lines: a circular buffer of the latest lines
 * and a longer one of warnings and errors, both with repeated lines folded
 * into one ("×37"), and an emitter that hands them to Kiosko at most once a
 * second however fast the log runs.
 */
import { mask } from './mask.ts';
import type { Entry } from './parse.ts';
import { rank, type Kind, type LogData, type LogLine, type LogStatus } from './types.ts';

/** Lines kept per source: more than any panel shows, few enough to send every second. */
export const MAX_LINES = 300;
/** Warnings and errors kept per source (folded), for the curve and the last error. */
export const MAX_ALERTS = 1000;
/** …and for how long. */
export const ALERTS_MS = 24 * 3600_000;
/** How far back a repeated line is looked for: a burst interleaved with a few others still folds. */
const LOOKBACK = 8;
/** A repeat this long after the last one starts a group of its own. */
const GROUP_GAP_MS = 15 * 60_000;
/** Warnings and errors fold within a minute at most, so the curve keeps the shape of a burst. */
const ALERT_SPAN_MS = 60_000;

const same = (a: LogLine, e: Entry) => a.msg === e.msg && a.unit === e.unit && a.level === e.level;

/** Adds `e` to `list`, folded into a recent identical line if there is one. Never mutates a line: a snapshot already sent stays as it was. */
function addTo(list: LogLine[], line: LogLine, max: number, spanMs = Infinity): void {
  for (let i = list.length - 1; i >= Math.max(0, list.length - LOOKBACK); i--) {
    const old = list[i]!;
    if (same(old, line) && Math.abs(line.t - old.t) <= GROUP_GAP_MS && Math.max(old.t, line.t) - Math.min(old.first, line.first) < spanMs) {
      list.splice(i, 1);
      list.push({ ...old, t: Math.max(old.t, line.t), first: Math.min(old.first, line.first), count: old.count + line.count });
      return;
    }
  }
  list.push(line);
  if (list.length > max) list.splice(0, list.length - max);
}

export class LogBuffer {
  lines: LogLine[] = [];
  alerts: LogLine[] = [];
  readonly kind: Kind;
  private readonly maxLines: number;
  private readonly maxAlerts: number;
  private readonly alertsMs: number;

  constructor(kind: Kind, o: { maxLines?: number; maxAlerts?: number; alertsMs?: number } = {}) {
    this.kind = kind;
    this.maxLines = o.maxLines ?? MAX_LINES;
    this.maxAlerts = o.maxAlerts ?? MAX_ALERTS;
    this.alertsMs = o.alertsMs ?? ALERTS_MS;
  }

  /** A line as read: masked, then kept (and, if a warning or worse, kept longer). */
  add(e: Entry): void {
    const msg = mask(e.msg);
    if (!msg) return;
    const line: LogLine = { t: e.t, first: e.t, count: 1, level: e.level, kind: this.kind, unit: mask(e.unit), msg };
    addTo(this.lines, line, this.maxLines);
    if (rank(e.level) <= rank('warning')) {
      addTo(this.alerts, line, this.maxAlerts, ALERT_SPAN_MS);
      const cut = e.t - this.alertsMs;
      if (this.alerts[0] && this.alerts[0].t < cut) this.alerts = this.alerts.filter((a) => a.t >= cut);
    }
  }

  /** What the widgets get: copies of the lists, and the status. */
  snapshot(status: LogStatus): LogData {
    return { kind: this.kind, lines: this.lines.slice(), alerts: this.alerts.slice(), status };
  }
}

/**
 * Calls `fn` at most once every `gapMs`: the first call at once, the ones
 * during the gap folded into one at its end. `cancel` drops a pending one.
 */
export function throttle(fn: () => void, gapMs = 1000, clock: () => number = Date.now): { schedule(): void; cancel(): void } {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = () => {
    timer = undefined;
    if (stopped) return;
    last = clock();
    fn();
  };
  return {
    schedule() {
      if (stopped || timer) return;
      const wait = last + gapMs - clock();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
