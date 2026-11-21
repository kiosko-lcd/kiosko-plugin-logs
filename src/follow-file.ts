/**
 * `tail -F` in Node: follows the end of a file and survives what happens to
 * log files. Rotation by renaming (logrotate's default: the file gets a new
 * inode, a new one takes its name) is noticed, the rest of the old one is
 * read, and the new one is followed from its start; truncation in place
 * (`copytruncate`, `> app.log`) starts again from the top; a file that isn't
 * there yet is waited for. It polls (every half second by default) rather
 * than trusting `fs.watch`, which misses renames on some systems and network
 * folders. A file growing faster than it can be shown is skipped forward,
 * not read to the last byte.
 */
import { open, stat, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { sleep } from './supervise.ts';
import type { LogStatus } from './types.ts';

export interface FollowFileOptions {
  signal: AbortSignal;
  onLine: (line: string) => void;
  status: (s: LogStatus) => void;
  pollMs?: number;
  /** How much of the end of the file to show when it is first opened. */
  backlogBytes?: number;
  /** Read at most this much per poll; further behind than `skipBytes`, jump ahead. */
  chunkBytes?: number;
  skipBytes?: number;
}

interface Identity {
  ino: number;
  dev: number;
  birth: number;
}
const identity = (s: { ino: number; dev: number; birthtimeMs: number }): Identity => ({ ino: s.ino, dev: s.dev, birth: Math.round(s.birthtimeMs) });
/** Another file now has the name: a new inode (or, where inodes are all 0, a new birth time). */
const replaced = (a: Identity, b: Identity) => a.dev !== b.dev || a.ino !== b.ino || (a.ino === 0 && a.birth !== 0 && b.birth !== 0 && a.birth !== b.birth);

/** Follows `path` until `o.signal` aborts. Throws on what waiting won't fix (no permission, a folder). */
export async function followFile(path: string, o: FollowFileOptions): Promise<void> {
  const pollMs = o.pollMs ?? 500;
  const backlog = o.backlogBytes ?? 16_384;
  const chunk = o.chunkBytes ?? 1 << 20;
  const skip = o.skipBytes ?? 8 << 20;
  let fh: FileHandle | null = null;
  let id: Identity | null = null;
  let pos = 0;
  let pending = '';
  let decoder = new StringDecoder('utf8');
  let first = true;
  let waitingSaid = false;

  const emitText = (text: string, final = false) => {
    const parts = (pending + text).split(/\r?\n/);
    pending = final ? '' : (parts.pop() ?? '');
    if (pending.length > 65_536) {
      parts.push(pending);
      pending = '';
    }
    for (const p of parts) if (p.trim()) o.onLine(p);
  };

  /** Reads what was added since `pos`, up to `size`. */
  const drain = async (size: number, final = false) => {
    if (!fh) return;
    if (size - pos > skip) {
      o.onLine(`[kiosko: skipped ${Math.round((size - pos - backlog) / 1024)} KB of a fast-growing log]`);
      pos = size - backlog;
      pending = '';
      decoder = new StringDecoder('utf8');
      await dropPartialLine();
    }
    while (pos < size && !o.signal.aborted) {
      const n = Math.min(chunk, size - pos);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      emitText(decoder.write(buf.subarray(0, bytesRead)));
      if (n === chunk) break; // the rest on the next poll: one burst never holds the loop
    }
    if (final) emitText(decoder.end(), true);
  };

  /** After jumping into the middle of a file, the first (cut) line is not shown. */
  const dropPartialLine = async () => {
    if (!fh || pos === 0) return;
    const buf = Buffer.alloc(Math.min(4096, backlog));
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl >= 0) pos += nl + 1;
  };

  const close = async () => {
    const f = fh;
    fh = null;
    await f?.close().catch(() => undefined);
  };

  try {
    while (!o.signal.aborted) {
      if (!fh) {
        try {
          fh = await open(path, 'r');
          const st = await fh.stat();
          if (st.isDirectory()) throw Object.assign(new Error(`${path}: is a folder`), { code: 'EISDIR' });
          id = identity(st);
          pos = first ? Math.max(0, st.size - backlog) : 0;
          pending = '';
          decoder = new StringDecoder('utf8');
          if (first) await dropPartialLine();
          first = false;
          waitingSaid = false;
          o.status({ state: 'following' });
        } catch (err) {
          await close();
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            if (!waitingSaid) o.status({ state: 'waiting', message: `${path}: not there yet` });
            waitingSaid = true;
            // A file that appears later is read from its start: it is all new.
            first = false;
            await sleep(pollMs, o.signal);
            continue;
          }
          if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(`${path}: permission denied`);
          throw e;
        }
      }
      const now = await fh.stat();
      if (now.size < pos) {
        // Truncated in place: start again from the top.
        pos = 0;
        pending = '';
        decoder = new StringDecoder('utf8');
      }
      await drain(now.size);
      let renamed = false;
      try {
        renamed = replaced(id!, identity(await stat(path)));
      } catch (err) {
        renamed = (err as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (renamed) {
        // Rotated: what was written to the old file before the switch, then the new one from its start.
        await drain((await fh.stat()).size, true);
        await close();
        continue;
      }
      await sleep(pollMs, o.signal);
    }
  } finally {
    await close();
  }
}
