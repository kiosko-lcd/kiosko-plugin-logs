/**
 * Live logs on the panel: the end of your logs, errors per minute and the
 * last error, from journald, files, Docker, macOS, Windows, Kubernetes and
 * Loki. Errors show as they happen and keep the tile a while; secrets and
 * e-mail addresses are masked before anything is kept or painted.
 */
import { definePlugin } from '@kiosko/sdk';
import { L, LANGUAGES } from './i18n.ts';
import { SOURCES } from './sources.ts';
import { WIDGETS } from './widgets.ts';

export { mask } from './mask.ts';
export { journal, file, docker, macos, windows, kubernetes, loki } from './sources.ts';
export { tail, rate, last } from './widgets.ts';

export default definePlugin({
  id: 'logs',
  name: L('Logs', 'Logs', 'Logs', '日志', '日誌'),
  version: '0.1.2',
  description: L(
    'Live logs on your panel: journald, log files, Docker, macOS, Windows, Kubernetes and Loki. Errors show as they happen, repeats fold, secrets are masked.',
    'Logs en vivo en tu panel: journald, archivos de log, Docker, macOS, Windows, Kubernetes y Loki. Los errores aparecen según ocurren, las repeticiones se agrupan y los secretos se ocultan.',
    'Live-Logs auf deinem Panel: journald, Logdateien, Docker, macOS, Windows, Kubernetes und Loki. Fehler erscheinen sofort, Wiederholungen werden zusammengefasst, Geheimnisse maskiert.',
    '在副屏上实时查看日志：journald、日志文件、Docker、macOS、Windows、Kubernetes 和 Loki。错误即时出现，重复行合并，机密信息被遮盖。',
    '在面板上即時查看日誌：journald、日誌檔、Docker、macOS、Windows、Kubernetes 與 Loki。錯誤即時出現，重複行合併，機密資訊被遮蓋。',
  ),
  author: 'Loksly',
  license: 'MIT',
  homepage: 'https://github.com/kiosko-lcd/kiosko-plugin-logs#readme',
  repository: 'https://github.com/kiosko-lcd/kiosko-plugin-logs',
  icon: 'scroll-text',
  sdk: '^0.2.0',
  languages: LANGUAGES,
  permissions: {
    exec: ['journalctl', 'log', 'powershell', 'kubectl', 'user'],
    files: ['user'],
    network: ['user'],
    devices: ['docker', 'journald'],
  },
  widgets: WIDGETS,
  sources: SOURCES,
});
