/**
 * What every source hands to the widgets: the latest lines of its logs, the
 * warnings and errors kept a while longer (for the curve and "the last
 * error"), and how the following goes.
 */

/** Severity, the same for every log: journald's eight priorities folded into five. */
export type Level = 'error' | 'warning' | 'notice' | 'info' | 'debug';

export const LEVELS: readonly Level[] = ['error', 'warning', 'notice', 'info', 'debug'];

/** 0 for `error` … 4 for `debug`: lower is more severe, like syslog. */
export const rank = (l: Level): number => LEVELS.indexOf(l);

/** Where a line comes from. */
export type Kind = 'journal' | 'file' | 'docker' | 'macos' | 'windows' | 'kubernetes' | 'loki';

/** One line, or several identical ones in a row (`count`). Already masked. */
export interface LogLine {
  /** When it was logged (the last one, when grouped), epoch ms. */
  t: number;
  /** When the first of a group was logged. Same as `t` for a single line. */
  first: number;
  /** How many identical lines it stands for. */
  count: number;
  level: Level;
  kind: Kind;
  /** The unit, container, file, process or pod it comes from: `nginx.service`, `web`, `app.log`. */
  unit: string;
  /** The message, on one line, secrets masked, at most `MAX_MESSAGE` characters. */
  msg: string;
}

/** How a source's following goes. */
export interface LogStatus {
  /**
   * `following`: lines arrive. `waiting`: nothing to follow yet (a file that
   * isn't there, no container running). `error`: the follower failed and is
   * being restarted. `off`: not configured, or not on this system.
   */
  state: 'following' | 'waiting' | 'error' | 'off';
  /** Why, for the tile when there is nothing else to show: `journalctl: not found`. */
  message?: string;
}

export interface LogData {
  kind: Kind;
  /** Latest lines, oldest first. */
  lines: LogLine[];
  /** Warnings and errors, oldest first, kept longer than `lines`. */
  alerts: LogLine[];
  status: LogStatus;
}

/** Longest message kept, in characters: a panel shows a fraction of it anyway. */
export const MAX_MESSAGE = 400;
