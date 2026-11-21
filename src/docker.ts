/**
 * Docker's logs through its API, on its Unix socket (or Windows named pipe),
 * with nothing installed: list the running containers, follow the chosen
 * ones' logs (`follow=1`, with timestamps), and pick up new and restarted
 * containers as they come.
 *
 * Reaching the socket is reaching Docker, and Docker can do anything as
 * root: this code only ever sends GET requests, to `/containers/json`,
 * `/containers/{id}/json` and `/containers/{id}/logs`.
 */
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

/**
 * Where Docker listens, when the user didn't say: `DOCKER_HOST` if it is a
 * `unix://` or `npipe://` address, else rootless Docker's socket in
 * `$XDG_RUNTIME_DIR`, Docker Desktop's in the home folder, the system one.
 */
export function defaultDockerSocket(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean; home?: string } = {}): string {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const host = env.DOCKER_HOST ?? '';
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  if (host.startsWith('npipe://')) return host.slice('npipe://'.length).replace(/\//g, '\\');
  if (platform === 'win32') return '\\\\.\\pipe\\docker_engine';
  const candidates = [
    env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'docker.sock') : '',
    (o.home ?? env.HOME) ? join((o.home ?? env.HOME)!, '.docker', 'run', 'docker.sock') : '',
    '/var/run/docker.sock',
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) ?? '/var/run/docker.sock';
}

/** Why the socket can't be used, in words. */
function socketError(socket: string, err: NodeJS.ErrnoException): Error {
  if (err.code === 'ENOENT') return new Error(`Docker: no socket at ${socket}`);
  if (err.code === 'EACCES') return new Error(`Docker: no permission on ${socket} (the docker group, or rootless Docker)`);
  if (err.code === 'ECONNREFUSED') return new Error('Docker: not running');
  return new Error(`Docker: ${err.message}`);
}

/** A GET to the Docker API; the body as JSON. */
export function dockerJson<T>(socket: string, path: string, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'GET', headers: { Host: 'docker' }, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(`Docker: ${res.statusCode} ${body.slice(0, 200).trim()}`));
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          reject(new Error('Docker: not JSON'));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(15_000, () => req.destroy(new Error('Docker: no answer in 15 s')));
    req.on('error', (err: NodeJS.ErrnoException) => reject(err.name === 'AbortError' ? err : socketError(socket, err)));
    req.end();
  });
}

/** A GET whose body is a stream: each chunk to `onChunk`, resolved when it ends (the container stopped). */
export function dockerStream(socket: string, path: string, signal: AbortSignal, onChunk: (c: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'GET', headers: { Host: 'docker' }, signal }, (res) => {
      if ((res.statusCode ?? 500) >= 300) {
        res.resume();
        return reject(new Error(`Docker: ${res.statusCode} for ${path.split('?')[0]}`));
      }
      res.on('data', onChunk);
      res.on('end', () => resolve());
      res.on('error', (err) => (signal.aborted ? resolve() : reject(err)));
    });
    req.on('error', (err: NodeJS.ErrnoException) => (signal.aborted ? resolve() : reject(socketError(socket, err))));
    req.end();
  });
}

export interface Container {
  id: string;
  /** Without the leading slash: `web`, `stack-db-1`. */
  name: string;
  /** Compose service and project, when it has them: also matched by the filter. */
  service?: string;
  project?: string;
}

/** Running containers. */
export async function listContainers(socket: string, signal: AbortSignal): Promise<Container[]> {
  const list = await dockerJson<{ Id: string; Names?: string[]; Labels?: Record<string, string> }[]>(socket, '/containers/json', signal);
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    ...(c.Labels?.['com.docker.compose.service'] ? { service: c.Labels['com.docker.compose.service'] } : {}),
    ...(c.Labels?.['com.docker.compose.project'] ? { project: c.Labels['com.docker.compose.project'] } : {}),
  }));
}

/** Whether the container has a TTY: then its logs are plain bytes, not frames. */
export async function hasTty(socket: string, id: string, signal: AbortSignal): Promise<boolean> {
  const c = await dockerJson<{ Config?: { Tty?: boolean } }>(socket, `/containers/${encodeURIComponent(id)}/json`, signal);
  return !!c.Config?.Tty;
}

/** The logs request: follow, both streams, timestamps; the last `tail` lines, or from `since` (ms) on. */
export function logsPath(id: string, o: { tail: number; since?: number }): string {
  const q = new URLSearchParams({ follow: '1', stdout: '1', stderr: '1', timestamps: '1', tail: String(o.tail) });
  if (o.since) q.set('since', (o.since / 1000).toFixed(3));
  return `/containers/${encodeURIComponent(id)}/logs?${q}`;
}
