/**
 * One push source per kind of log. Each follows its log while some widget
 * uses it, keeps the latest lines in a circular buffer (masked, repeats
 * folded) and hands them to Kiosko at most once a second. A source with
 * nothing to follow (no file set, no container chosen, another operating
 * system) runs nothing and says so.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineSource, t, type Choice, type SourceContext } from '@kiosko/sdk';
import { LogBuffer, throttle } from './buffer.ts';
import { demoData } from './demo.ts';
import { defaultDockerSocket } from './docker.ts';
import { followDocker, followFiles, followJournal, followKube, followLoki, followMacos, followWindows, type Hooks } from './follow.ts';
import { L } from './i18n.ts';
import type { Kind, LogData, LogStatus } from './types.ts';

/** Emitted at most this often, however fast the log runs. */
export const EMIT_GAP_MS = 1000;

/** `~`, `~/…` and `$VAR`/`${VAR}` expanded. */
export function expand(p: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const v = p.trim().replace(/\$(?:\{(\w+)\}|(\w+))/g, (whole, a?: string, b?: string) => env[a ?? b ?? ''] ?? whole);
  if (v === '~') return home;
  return /^~[\\/]/.test(v) ? join(home, v.slice(2)) : v;
}

/**
 * The `watch` of a source: a buffer, a throttled emit, and the follower
 * `run` starts (or the status saying why there is none). Stops everything
 * when Kiosko stops the source.
 */
export function watchWith<O>(kind: Kind, run: (o: O, h: Hooks, ctx: SourceContext<O>) => Promise<void> | LogStatus, gapMs = EMIT_GAP_MS) {
  return (ctx: SourceContext<O>, emit: (d: LogData) => void): (() => void) => {
    const ac = new AbortController();
    const signal = AbortSignal.any([ctx.signal, ac.signal]);
    const buf = new LogBuffer(kind);
    let status: LogStatus = { state: 'following' };
    const out = throttle(() => emit(buf.snapshot(status)), gapMs);
    const h: Hooks = {
      signal,
      add: (e) => {
        buf.add(e);
        out.schedule();
      },
      status: (s) => {
        if (s.state === status.state && s.message === status.message) return;
        status = s;
        out.schedule();
      },
      log: (m) => ctx.log(`logs/${kind}: ${m}`),
    };
    const started = run(ctx.options, h, ctx);
    if (started instanceof Promise) {
      started.catch((err) => h.status({ state: 'error', message: err instanceof Error ? err.message : String(err) }));
      out.schedule();
    } else {
      status = started;
      emit(buf.snapshot(status));
    }
    return () => {
      ac.abort();
      out.cancel();
    };
  };
}

/** The units seen, for the editor to offer in a filter. */
const unitChoices = (d: LogData): Choice[] => [...new Set([...d.lines, ...d.alerts].map((l) => l.unit))].sort().map((value) => ({ value }));

const choices = { units: unitChoices };

const OFF_PLATFORM = (what: string): LogStatus => ({ state: 'off', message: `${what}: not on this system` });

const levelLabels = {
  error: L('Errors', 'Errores', 'Fehler', '错误', '錯誤'),
  warning: L('Warnings and worse', 'Avisos y peor', 'Warnungen und schlimmer', '警告及以上', '警告及以上'),
  notice: L('Notices and worse', 'Notas y peor', 'Hinweise und schlimmer', '通知及以上', '通知及以上'),
  info: L('Information and worse', 'Información y peor', 'Informationen und schlimmer', '信息及以上', '資訊及以上'),
  debug: L('Everything (debug too)', 'Todo (también depuración)', 'Alles (auch Debug)', '全部（包括调试）', '全部（包括除錯）'),
};

const binField = (program: string) =>
  t.string({
    default: '',
    risk: 'exec',
    advanced: true,
    placeholder: program,
    label: L('Program', 'Programa', 'Programm', '程序', '程式'),
    help: L(
      `The ${program} to run, by its full path. Empty: ${program} from the PATH.`,
      `El ${program} que ejecutar, con su ruta completa. Vacío: el ${program} del PATH.`,
      `Das auszuführende ${program} mit vollständigem Pfad. Leer: ${program} aus dem PATH.`,
      `要运行的 ${program} 的完整路径。留空：使用 PATH 中的 ${program}。`,
      `要執行的 ${program} 的完整路徑。留空：使用 PATH 中的 ${program}。`,
    ),
  });

/* journald --------------------------------------------------------------------------------- */

export const journal = defineSource({
  id: 'journal',
  name: L('systemd journal', 'Diario de systemd', 'systemd-Journal', 'systemd 日志', 'systemd 日誌'),
  description: L(
    'Follows the journal with journalctl, as it is written (Linux). Without the systemd-journal or adm group you see only your own user’s messages.',
    'Sigue el diario con journalctl, según se escribe (Linux). Sin el grupo systemd-journal o adm solo ves los mensajes de tu usuario.',
    'Folgt dem Journal mit journalctl, während es geschrieben wird (Linux). Ohne die Gruppe systemd-journal oder adm siehst du nur die Meldungen deines Benutzers.',
    '用 journalctl 实时跟踪日志（Linux）。不在 systemd-journal 或 adm 组中时，只能看到你自己用户的消息。',
    '用 journalctl 即時追蹤日誌（Linux）。不在 systemd-journal 或 adm 群組中時，只能看到你自己使用者的訊息。',
  ),
  options: t.object({
    units: t.filter({
      label: L('Units', 'Unidades', 'Units', '单元', '單元'),
      choices: { source: 'logs/journal', list: 'units' },
    }),
    priority: t.enum(['error', 'warning', 'notice', 'info', 'debug'], {
      default: 'info',
      label: L('Read from', 'Leer desde', 'Lesen ab', '读取级别', '讀取層級'),
      labels: levelLabels,
      help: L(
        'The least serious messages journalctl reads. Each widget can show fewer.',
        'Los mensajes menos graves que lee journalctl. Cada widget puede mostrar menos.',
        'Die am wenigsten ernsten Meldungen, die journalctl liest. Jedes Widget kann weniger zeigen.',
        'journalctl 读取的最低级别消息。每个小组件可以显示更少。',
        'journalctl 讀取的最低層級訊息。每個小工具可以顯示更少。',
      ),
    }),
    onlyUser: t.boolean({
      default: false,
      label: L('Only my user’s journal', 'Solo el diario de mi usuario', 'Nur das Journal meines Benutzers', '仅我的用户日志', '僅我的使用者日誌'),
      help: L('journalctl --user: your user services, not the system’s.', 'journalctl --user: tus servicios de usuario, no los del sistema.', 'journalctl --user: deine Benutzerdienste, nicht die des Systems.', 'journalctl --user：你的用户服务，而不是系统的。', 'journalctl --user：你的使用者服務，而不是系統的。'),
    }),
    bin: binField('journalctl'),
  }),
  watch: watchWith('journal', (o, h) => (process.platform === 'linux' ? followJournal(o, h) : OFF_PLATFORM('journald'))),
  demo: ({ now }) => demoData('journal', now),
  choices,
});

/* files -------------------------------------------------------------------------------------- */

export const file = defineSource({
  id: 'file',
  name: L('Log files', 'Archivos de log', 'Logdateien', '日志文件', '日誌檔'),
  description: L(
    'Follows the end of log files, like tail -F: it survives rotation and truncation and waits for a file that isn’t there yet.',
    'Sigue el final de archivos de log, como tail -F: sobrevive a la rotación y al vaciado y espera a un archivo que aún no existe.',
    'Folgt dem Ende von Logdateien wie tail -F: übersteht Rotation und Kürzen und wartet auf eine Datei, die es noch nicht gibt.',
    '像 tail -F 一样跟踪日志文件的末尾：能应对轮转和清空，并等待尚不存在的文件。',
    '像 tail -F 一樣追蹤日誌檔的結尾：能應付輪替與清空，並等待尚不存在的檔案。',
  ),
  options: t.object({
    paths: t.list(t.string({ default: '', format: 'path', risk: 'path', placeholder: '/var/log/nginx/error.log' }), {
      risk: 'path',
      max: 20,
      label: L('Files', 'Archivos', 'Dateien', '文件', '檔案'),
      help: L(
        'One or more log files, by their full path. Empty: none is read.',
        'Uno o más archivos de log, con su ruta completa. Vacío: no se lee ninguno.',
        'Eine oder mehrere Logdateien mit vollständigem Pfad. Leer: keine wird gelesen.',
        '一个或多个日志文件的完整路径。留空：不读取任何文件。',
        '一個或多個日誌檔的完整路徑。留空：不讀取任何檔案。',
      ),
    }),
  }),
  watch: watchWith('file', (o, h) => {
    const paths = [...new Set(o.paths.map((p) => expand(p)).filter(Boolean))];
    return paths.length ? followFiles(paths, h) : { state: 'off', message: 'no log file set' };
  }),
  demo: ({ now }) => demoData('file', now),
  choices,
});

/* Docker ---------------------------------------------------------------------------------------- */

export const docker = defineSource({
  id: 'docker',
  name: L('Docker containers', 'Contenedores Docker', 'Docker-Container', 'Docker 容器', 'Docker 容器'),
  description: L(
    'Follows the logs of the containers you choose, through Docker’s socket. Access to that socket is root access to the machine: give it only on a machine you trust.',
    'Sigue los logs de los contenedores que elijas, por el socket de Docker. Acceder a ese socket es acceder como root a la máquina: dáselo solo en una máquina de confianza.',
    'Folgt den Logs der gewählten Container über Dockers Socket. Zugriff auf diesen Socket ist Root-Zugriff auf den Rechner: nur auf einem Rechner geben, dem du vertraust.',
    '通过 Docker 的套接字跟踪你选择的容器的日志。能访问这个套接字就等于拥有这台机器的 root 权限：只在你信任的机器上开启。',
    '透過 Docker 的 socket 追蹤你選擇的容器日誌。能存取這個 socket 就等於擁有這台機器的 root 權限：只在你信任的機器上開啟。',
  ),
  options: t.object({
    containers: t.filter({
      label: L('Containers', 'Contenedores', 'Container', '容器', '容器'),
      help: L(
        'Which running containers to follow, by name or Compose service: web, db-*, !*-test. Empty: none, Docker is not read; * for all.',
        'Qué contenedores en marcha seguir, por nombre o servicio de Compose: web, db-*, !*-test. Vacío: ninguno, no se lee Docker; * para todos.',
        'Welche laufenden Container verfolgt werden, nach Name oder Compose-Dienst: web, db-*, !*-test. Leer: keiner, Docker wird nicht gelesen; * für alle.',
        '要跟踪哪些运行中的容器（按名称或 Compose 服务）：web, db-*, !*-test。留空：不读取 Docker；* 表示全部。',
        '要追蹤哪些執行中的容器（依名稱或 Compose 服務）：web, db-*, !*-test。留空：不讀取 Docker；* 表示全部。',
      ),
      choices: { source: 'logs/docker', list: 'units' },
    }),
    socket: t.string({
      default: '',
      format: 'path',
      risk: 'path',
      advanced: true,
      placeholder: '/var/run/docker.sock',
      label: L('Docker socket', 'Socket de Docker', 'Docker-Socket', 'Docker 套接字', 'Docker socket'),
      help: L(
        'Empty: DOCKER_HOST, else rootless Docker’s ($XDG_RUNTIME_DIR/docker.sock), Docker Desktop’s, or /var/run/docker.sock.',
        'Vacío: DOCKER_HOST, o si no el de Docker sin root ($XDG_RUNTIME_DIR/docker.sock), el de Docker Desktop o /var/run/docker.sock.',
        'Leer: DOCKER_HOST, sonst der von rootlosem Docker ($XDG_RUNTIME_DIR/docker.sock), der von Docker Desktop oder /var/run/docker.sock.',
        '留空：使用 DOCKER_HOST，否则依次为无 root Docker 的（$XDG_RUNTIME_DIR/docker.sock）、Docker Desktop 的或 /var/run/docker.sock。',
        '留空：使用 DOCKER_HOST，否則依序為無 root Docker 的（$XDG_RUNTIME_DIR/docker.sock）、Docker Desktop 的或 /var/run/docker.sock。',
      ),
    }),
  }),
  watch: watchWith('docker', (o, h) => {
    if (!o.containers.length) return { state: 'off', message: 'no container chosen' };
    return followDocker({ containers: o.containers, socket: expand(o.socket) || defaultDockerSocket() }, h);
  }),
  demo: ({ now }) => demoData('docker', now),
  choices,
});

/* macOS -------------------------------------------------------------------------------------------- */

export const macos = defineSource({
  id: 'macos',
  name: L('macOS unified log', 'Registro unificado de macOS', 'Einheitliches macOS-Protokoll', 'macOS 统一日志', 'macOS 統一日誌'),
  description: L(
    'Follows macOS’s log with log stream. By default only errors and faults: the whole log is thousands of lines a second.',
    'Sigue el registro de macOS con log stream. Por omisión solo errores y fallos: el registro entero son miles de líneas por segundo.',
    'Folgt dem macOS-Protokoll mit log stream. Standardmäßig nur Fehler: das ganze Protokoll sind Tausende Zeilen pro Sekunde.',
    '用 log stream 跟踪 macOS 日志。默认只看错误和故障：完整日志每秒有成千上万行。',
    '用 log stream 追蹤 macOS 日誌。預設只看錯誤與故障：完整日誌每秒有成千上萬行。',
  ),
  options: t.object({
    predicate: t.string({
      default: 'messageType == error OR messageType == fault',
      label: L('Predicate', 'Predicado', 'Prädikat', '谓词', '述詞'),
      help: L(
        'Which messages, as log stream --predicate takes it: process == "nginx", subsystem == "com.example.app". Empty: all of them.',
        'Qué mensajes, como lo toma log stream --predicate: process == "nginx", subsystem == "com.example.app". Vacío: todos.',
        'Welche Meldungen, wie log stream --predicate es nimmt: process == "nginx", subsystem == "com.example.app". Leer: alle.',
        '要哪些消息，按 log stream --predicate 的写法：process == "nginx"、subsystem == "com.example.app"。留空：全部。',
        '要哪些訊息，依 log stream --predicate 的寫法：process == "nginx"、subsystem == "com.example.app"。留空：全部。',
      ),
    }),
    level: t.enum(['default', 'info', 'debug'], {
      default: 'default',
      label: L('Level', 'Nivel', 'Stufe', '级别', '層級'),
      labels: {
        default: L('Default', 'Normal', 'Standard', '默认', '預設'),
        info: L('Info too', 'También info', 'Auch Info', '包括信息', '包括資訊'),
        debug: L('Debug too', 'También depuración', 'Auch Debug', '包括调试', '包括除錯'),
      },
    }),
    bin: binField('/usr/bin/log'),
  }),
  watch: watchWith('macos', (o, h) => (process.platform === 'darwin' ? followMacos(o, h) : OFF_PLATFORM('macOS log'))),
  demo: ({ now }) => demoData('macos', now),
  choices,
});

/* Windows -------------------------------------------------------------------------------------------- */

export const windows = defineSource({
  id: 'windows',
  name: L('Windows Event Log', 'Visor de eventos de Windows', 'Windows-Ereignisprotokoll', 'Windows 事件日志', 'Windows 事件記錄'),
  description: L(
    'New events of the Windows logs you choose, read with PowerShell’s Get-WinEvent every 15 seconds.',
    'Los eventos nuevos de los registros de Windows que elijas, leídos con Get-WinEvent de PowerShell cada 15 segundos.',
    'Neue Ereignisse der gewählten Windows-Protokolle, alle 15 Sekunden mit Get-WinEvent aus PowerShell gelesen.',
    '你选择的 Windows 日志中的新事件，每 15 秒用 PowerShell 的 Get-WinEvent 读取一次。',
    '你選擇的 Windows 記錄中的新事件，每 15 秒用 PowerShell 的 Get-WinEvent 讀取一次。',
  ),
  options: t.object({
    logs: t.list(t.string({ default: '' }), {
      default: ['System', 'Application'],
      max: 10,
      label: L('Logs', 'Registros', 'Protokolle', '日志', '記錄'),
      help: L('Event log names: System, Application, Security (needs an administrator)…', 'Nombres de registro: System, Application, Security (requiere administrador)…', 'Namen der Protokolle: System, Application, Security (braucht Administrator)…', '事件日志名称：System、Application、Security（需要管理员）…', '事件記錄名稱：System、Application、Security（需要系統管理員）…'),
    }),
    priority: t.enum(['error', 'warning', 'info'], {
      default: 'warning',
      label: L('Read from', 'Leer desde', 'Lesen ab', '读取级别', '讀取層級'),
      labels: { error: levelLabels.error, warning: levelLabels.warning, info: levelLabels.info },
    }),
    bin: binField('powershell.exe'),
  }),
  watch: watchWith('windows', (o, h) => (process.platform === 'win32' ? followWindows(o, h) : OFF_PLATFORM('Windows events'))),
  demo: ({ now }) => demoData('windows', now),
  choices,
});

/* Kubernetes -------------------------------------------------------------------------------------------- */

export const kubernetes = defineSource({
  id: 'kubernetes',
  name: L('Kubernetes pods', 'Pods de Kubernetes', 'Kubernetes-Pods', 'Kubernetes Pod', 'Kubernetes Pod'),
  description: L(
    'Follows pods’ logs with kubectl logs -f, with your kubeconfig and its permissions.',
    'Sigue los logs de pods con kubectl logs -f, con tu kubeconfig y sus permisos.',
    'Folgt den Logs von Pods mit kubectl logs -f, mit deiner kubeconfig und ihren Rechten.',
    '用 kubectl logs -f 跟踪 Pod 日志，使用你的 kubeconfig 及其权限。',
    '用 kubectl logs -f 追蹤 Pod 日誌，使用你的 kubeconfig 及其權限。',
  ),
  options: t.object({
    selector: t.string({
      default: '',
      placeholder: 'app=shop',
      label: L('Pods', 'Pods', 'Pods', 'Pod', 'Pod'),
      help: L('A label selector (app=shop) or a resource (deployment/shop). Empty: kubectl is not run.', 'Un selector de etiquetas (app=shop) o un recurso (deployment/shop). Vacío: no se ejecuta kubectl.', 'Ein Label-Selektor (app=shop) oder eine Ressource (deployment/shop). Leer: kubectl wird nicht ausgeführt.', '标签选择器（app=shop）或资源（deployment/shop）。留空：不运行 kubectl。', '標籤選擇器（app=shop）或資源（deployment/shop）。留空：不執行 kubectl。'),
    }),
    namespace: t.string({ default: '', label: L('Namespace', 'Espacio de nombres', 'Namespace', '命名空间', '命名空間') }),
    context: t.string({ default: '', risk: 'network', advanced: true, label: L('kubeconfig context', 'Contexto de kubeconfig', 'kubeconfig-Kontext', 'kubeconfig 上下文', 'kubeconfig 上下文'), help: L('Empty: the current one.', 'Vacío: el actual.', 'Leer: der aktuelle.', '留空：当前上下文。', '留空：目前的上下文。') }),
    bin: binField('kubectl'),
  }),
  watch: watchWith('kubernetes', (o, h) => (o.selector.trim() ? followKube(o, h) : { state: 'off', message: 'no pods chosen' })),
  demo: ({ now }) => demoData('kubernetes', now),
  choices,
});

/* Loki ---------------------------------------------------------------------------------------------------- */

export const loki = defineSource({
  id: 'loki',
  name: L('Grafana Loki', 'Grafana Loki', 'Grafana Loki', 'Grafana Loki', 'Grafana Loki'),
  description: L(
    'Live lines of a LogQL query, through Loki’s tail API.',
    'Las líneas en vivo de una consulta LogQL, por la API de tail de Loki.',
    'Live-Zeilen einer LogQL-Abfrage über Lokis Tail-API.',
    '通过 Loki 的 tail API 获取 LogQL 查询的实时日志行。',
    '透過 Loki 的 tail API 取得 LogQL 查詢的即時日誌行。',
  ),
  options: t.object({
    url: t.string({ default: '', format: 'url', risk: 'network', placeholder: 'http://loki.example.lan:3100', label: L('Loki address', 'Dirección de Loki', 'Loki-Adresse', 'Loki 地址', 'Loki 位址'), help: L('Empty: Loki is not contacted.', 'Vacío: no se contacta con Loki.', 'Leer: Loki wird nicht kontaktiert.', '留空：不连接 Loki。', '留空：不連線 Loki。') }),
    query: t.string({ default: '', placeholder: '{job="nginx"} |= "error"', label: L('Query (LogQL)', 'Consulta (LogQL)', 'Abfrage (LogQL)', '查询（LogQL）', '查詢（LogQL）') }),
    token: t.string({ default: '', secret: true, advanced: true, label: L('Token', 'Token', 'Token', '令牌', '權杖'), help: L('Sent as Authorization: Bearer. Or put user:password in the address.', 'Se envía como Authorization: Bearer. O pon usuario:contraseña en la dirección.', 'Wird als Authorization: Bearer gesendet. Oder Benutzer:Passwort in die Adresse.', '作为 Authorization: Bearer 发送。也可以在地址里写 用户:密码。', '以 Authorization: Bearer 傳送。也可以在位址裡寫 使用者:密碼。') }),
    orgId: t.string({ default: '', advanced: true, label: L('Tenant (X-Scope-OrgID)', 'Inquilino (X-Scope-OrgID)', 'Mandant (X-Scope-OrgID)', '租户（X-Scope-OrgID）', '租戶（X-Scope-OrgID）') }),
  }),
  watch: watchWith('loki', (o, h) => (o.url.trim() && o.query.trim() ? followLoki(o, h) : { state: 'off', message: 'no Loki address or query' })),
  demo: ({ now }) => demoData('loki', now),
  choices,
});

export const SOURCES = [journal, file, docker, macos, windows, kubernetes, loki];
