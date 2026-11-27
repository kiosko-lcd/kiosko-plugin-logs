/**
 * The three widgets: the end of the logs (a list, in monospace), errors per
 * minute (a curve) and the last error (big, for a small tile). All read the
 * same sources and filter them with the same options.
 */
import { defineWidget, drawEmpty, drawMore, listLayout, listOptions, t, type Graphics, type RenderContext, type StateContext } from '@kiosko/sdk';
import { demoData } from './demo.ts';
import { L } from './i18n.ts';
import { rank, type Kind, type Level, type LogLine } from './types.ts';
import { SOURCE_IDS, collect, fold, newest, perMinute, select, statuses, type ViewOptions } from './view.ts';

/** With no warning or error for this long, the logs are quiet: the widget is idle. */
export const QUIET_MS = 10 * 60_000;

/* Shared options ------------------------------------------------------------------------- */

const units = () =>
  t.filter({
    label: L('Units, containers, files', 'Unidades, contenedores, archivos', 'Units, Container, Dateien', '单元、容器、文件', '單元、容器、檔案'),
    help: L(
      'Which logs to show, by name: nginx.service, web, app.log; by kind: journal/*, docker/*, file/*; and !cron to leave one out. Empty: all.',
      'Qué logs mostrar, por nombre: nginx.service, web, app.log; por tipo: journal/*, docker/*, file/*; y !cron para quitar uno. Vacío: todos.',
      'Welche Logs gezeigt werden, nach Name: nginx.service, web, app.log; nach Art: journal/*, docker/*, file/*; und !cron, um eines wegzulassen. Leer: alle.',
      '按名称选择要显示的日志：nginx.service、web、app.log；按类型：journal/*、docker/*、file/*；用 !cron 排除某个。留空：全部。',
      '依名稱選擇要顯示的日誌：nginx.service、web、app.log；依類型：journal/*、docker/*、file/*；用 !cron 排除某個。留空：全部。',
    ),
  });

const messages = () =>
  t.filter({
    label: L('Messages', 'Mensajes', 'Meldungen', '消息', '訊息'),
    help: L(
      'Only lines with these words: timeout, refused; leave out with !healthcheck; a regular expression between slashes: /5\\d\\d/. Empty: all lines.',
      'Solo las líneas con estas palabras: timeout, refused; quita con !healthcheck; una expresión regular entre barras: /5\\d\\d/. Vacío: todas.',
      'Nur Zeilen mit diesen Wörtern: timeout, refused; weglassen mit !healthcheck; ein regulärer Ausdruck zwischen Schrägstrichen: /5\\d\\d/. Leer: alle Zeilen.',
      '只显示含这些词的行：timeout、refused；用 !healthcheck 排除；斜杠之间写正则表达式：/5\\d\\d/。留空：全部。',
      '只顯示含這些詞的行：timeout、refused；用 !healthcheck 排除；斜線之間寫正規表示式：/5\\d\\d/。留空：全部。',
    ),
  });

const holdMs = () =>
  t.duration({
    default: 2 * 60_000,
    max: 24 * 3600_000,
    label: L('An error keeps the tile for', 'Un error se queda la tesela', 'Ein Fehler hält die Kachel für', '出错后占用格子', '出錯後佔用方格'),
    help: L(
      'How long after an error the widget stays on its tile (urgent). 0: never.',
      'Cuánto tiempo después de un error se queda el widget en su tesela (urgente). 0: nunca.',
      'Wie lange das Widget nach einem Fehler auf seiner Kachel bleibt (dringend). 0: nie.',
      '出错后小组件在格子上停留多久（紧急）。0：从不。',
      '出錯後小工具在方格上停留多久（緊急）。0：從不。',
    ),
  });

const includeWarnings = (def: boolean) =>
  t.boolean({
    default: def,
    label: L('Include warnings', 'Incluir avisos', 'Warnungen einbeziehen', '包括警告', '包括警告'),
  });

/* Shared state -------------------------------------------------------------------------------- */

interface Filters {
  units: string[];
  messages: string[];
  holdMs: number;
}

/** The newest error the filters let through, if it is fresher than `holdMs`. */
export function freshError(sources: Record<string, unknown>, o: Filters, now: number): LogLine | null {
  if (!(o.holdMs > 0)) return null;
  const e = newest(select(collect(sources, 'alerts'), { units: o.units, messages: o.messages, level: 'error' }), 'error');
  return e && now - e.t < o.holdMs && e.t <= now + 60_000 ? e : null;
}

const urgent = ({ sources, options, now }: StateContext<Filters, undefined>) => !!freshError(sources, options, now);

const idle = ({ sources, options, now }: StateContext<Filters, undefined>) => {
  const w = newest(select(collect(sources, 'alerts'), { units: options.units, messages: options.messages, level: 'warning' }), 'warning');
  return !w || now - w.t >= QUIET_MS;
};

/** Every source's demo data at `now`. */
export function demoSources(now: number): Record<string, unknown> {
  const kinds: Kind[] = ['journal', 'file', 'docker'];
  return Object.fromEntries(kinds.map((k) => [`logs/${k}`, demoData(k, now)]));
}

/** Some log has delivered: before that the widget is loading, not empty. */
const delivered = (sources: Record<string, unknown>) => SOURCE_IDS.some((id) => sources[id] !== undefined);

/** What to say in an empty tile: why the sources have nothing, or that it's quiet. */
function emptyMessage(ctx: RenderContext<any, any>, quiet: string): string {
  const st = statuses(ctx.sources);
  if (st.some((s) => s.status.state === 'following')) return quiet;
  const bad = st.find((s) => s.status.state === 'error') ?? st.find((s) => s.status.state === 'waiting');
  if (bad?.status.message) return bad.status.message;
  if (!st.length) return ctx.t(L('Waiting for the logs…', 'Esperando a los logs…', 'Warte auf die Logs…', '正在等待日志…', '正在等待日誌…'));
  return ctx.t(L('Nothing to follow: set a log up in Settings → Data sources', 'Nada que seguir: configura un log en Ajustes → Fuentes de datos', 'Nichts zu verfolgen: richte ein Log unter Einstellungen → Datenquellen ein', '没有可跟踪的：请在“设置 → 数据源”中配置日志', '沒有可追蹤的：請在「設定 → 資料來源」中設定日誌'));
}

/* Drawing helpers --------------------------------------------------------------------------------- */

type Ctx = RenderContext<any, any>;

const colorOf = (ctx: Ctx, l: Level) => {
  const c = ctx.theme.colors;
  return l === 'error' ? c.alert : l === 'warning' ? c.warn : l === 'debug' ? c.inkDim : c.ink;
};

/** Latin and the like: one character, one cell. Anything else (CJK, emoji) is measured. */
const NARROW = /^[\u0000-ɏ -⁯←-⇿─-╿]*$/;

/**
 * Monospace text cut to `maxW`: by counting cells where every character is
 * one, which is far cheaper than measuring (a tail is dozens of long lines),
 * checked once, and measured only when that doesn't hold.
 */
function fitMono(g: Graphics, ctx: Ctx, text: string, maxW: number, font: { size: number; family: string }, cell: number): string {
  if (maxW <= 0) return '';
  if (NARROW.test(text) && cell > 0) {
    const n = Math.floor(maxW / cell);
    const cut = text.length <= n ? text : n <= 1 ? '…' : `${text.slice(0, n - 1).trimEnd()}…`;
    if (ctx.kit.measureTracked(g, cut, font) <= maxW + 0.5) return cut;
  }
  return ctx.kit.truncate(g, text, maxW, font);
}

/** Paints inside the box only, whatever happens. */
function clipped(g: Graphics, ctx: Ctx, paint: () => void): void {
  const { box } = ctx;
  g.save();
  g.beginPath();
  g.rect(box.x, box.y, box.w, box.h);
  g.clip();
  try {
    paint();
  } finally {
    g.restore();
  }
}

const countLabel = (n: number) => (n > 1 ? `×${n > 9999 ? `${Math.floor(n / 1000)}k` : n}` : '');

/* The tail ------------------------------------------------------------------------------------------ */

const tailOptions = t.object({
  level: t.enum(['error', 'warning', 'notice', 'info', 'debug'], {
    default: 'info',
    label: L('Show', 'Mostrar', 'Zeigen', '显示', '顯示'),
    labels: {
      error: L('Errors', 'Errores', 'Fehler', '错误', '錯誤'),
      warning: L('Warnings and worse', 'Avisos y peor', 'Warnungen und schlimmer', '警告及以上', '警告及以上'),
      notice: L('Notices and worse', 'Notas y peor', 'Hinweise und schlimmer', '通知及以上', '通知及以上'),
      info: L('Information and worse', 'Información y peor', 'Informationen und schlimmer', '信息及以上', '資訊及以上'),
      debug: L('Everything', 'Todo', 'Alles', '全部', '全部'),
    },
  }),
  units: units(),
  messages: messages(),
  showUnits: t.boolean({ default: true, label: L('Show where each line comes from', 'Mostrar de dónde viene cada línea', 'Zeigen, woher jede Zeile kommt', '显示每行的来源', '顯示每行的來源') }),
  showTime: t.boolean({ default: true, label: L('Show how long ago', 'Mostrar hace cuánto', 'Zeigen, wie lange her', '显示多久以前', '顯示多久以前') }),
  ...listOptions({ layouts: ['one-line', 'detailed'] }),
  holdMs: holdMs(),
});

/** The lines the tail shows, newest first. */
export function tailLines(sources: Record<string, unknown>, o: ViewOptions): LogLine[] {
  return fold(select(collect(sources, 'lines'), o)).reverse();
}

export const tail = defineWidget({
  id: 'tail',
  name: L('Live log', 'Log en vivo', 'Live-Log', '实时日志', '即時日誌'),
  description: L(
    'The end of your logs as they are written: errors in red, warnings in amber, repeats folded (×37), secrets masked.',
    'El final de tus logs según se escriben: errores en rojo, avisos en ámbar, repeticiones agrupadas (×37), secretos ocultos.',
    'Das Ende deiner Logs, während sie geschrieben werden: Fehler rot, Warnungen gelb, Wiederholungen zusammengefasst (×37), Geheimnisse maskiert.',
    '实时显示日志的末尾：错误为红色，警告为琥珀色，重复行合并（×37），机密信息已遮盖。',
    '即時顯示日誌的結尾：錯誤為紅色，警告為琥珀色，重複行合併（×37），機密資訊已遮蓋。',
  ),
  icon: 'scroll-text',
  category: 'system',
  tags: ['logs', 'journald', 'docker'],
  size: { min: { w: 240, h: 80 }, preferred: { w: 900, h: 300 } },
  options: tailOptions,
  sources: [...SOURCE_IDS],
  redraw: 'minute',
  urgent,
  idle,
  empty: ({ sources, options }) => delivered(sources) && !tailLines(sources, options).length,
  render(g, ctx) {
    const { box, options, theme, kit } = ctx;
    const lines = tailLines(ctx.sources, options);
    if (!lines.length) return drawEmpty(g, ctx, emptyMessage(ctx, ctx.t(L('Quiet: no lines to show', 'Tranquilo: ninguna línea que mostrar', 'Ruhig: keine Zeilen zu zeigen', '很安静：没有可显示的行', '很安靜：沒有可顯示的行'))));
    const plan = listLayout(box, lines.length, options, {
      sizes: { 'one-line': { min: 26, max: 44 }, detailed: { min: 48, max: 76 } },
      auto: (b, n) => (b.w < 480 && b.h / Math.max(1, Math.min(n, 4)) >= 48 ? 'detailed' : 'one-line'),
      minRows: 6,
    });
    const detailed = plan.layout === 'detailed';
    const mono = { size: plan.textSize, family: theme.fonts.mono };
    const small = { size: detailed ? plan.detailSize : Math.max(8, Math.round(plan.textSize * 0.86)), family: theme.fonts.mono };
    const cell = kit.measureTracked(g, 'MMMMMMMMMM', mono) / 10;
    const smallCell = kit.measureTracked(g, 'MMMMMMMMMM', small) / 10;
    const bar = Math.max(2, Math.round(plan.rowH * 0.12));
    const pad = bar + Math.max(4, Math.round(cell * 0.6));
    const gap = Math.max(4, Math.round(cell * 0.8));
    // Fixed columns for the one-line layout: the age, then where it comes from.
    const ageW = options.showTime && !detailed ? Math.max(smallCell * 6, ...lines.slice(0, plan.shown).map((l) => kit.measureTracked(g, ctx.fmt.ago(l.t, { suffix: false }), small))) : 0;
    const unitW = options.showUnits && !detailed ? Math.min(smallCell * 16, Math.round(box.w * 0.2), Math.max(...lines.slice(0, plan.shown).map((l) => smallCell * [...l.unit].length))) : 0;
    clipped(g, ctx, () => {
      plan.rows.forEach((row, i) => {
        const l = lines[i]!;
        const color = colorOf(ctx, l.level);
        if (rank(l.level) <= rank('warning')) {
          g.fillStyle = color;
          g.fillRect(row.x, row.y + plan.rowH * 0.18, bar, plan.rowH * 0.64);
        }
        const count = countLabel(l.count);
        if (!detailed) {
          const base = row.y + plan.rowH * 0.5 + plan.textSize * 0.36;
          let x = row.x + pad;
          if (ageW) {
            kit.drawTracked(g, ctx.fmt.ago(l.t, { suffix: false }), x + ageW, base, { ...small, color: theme.colors.inkDim, align: 'right' });
            x += ageW + gap;
          }
          if (unitW) {
            kit.drawTracked(g, fitMono(g, ctx, l.unit, unitW, small, smallCell), x, base, { ...small, color: theme.colors.inkDim });
            x += unitW + gap;
          }
          if (count) {
            x += kit.drawTracked(g, count, x, base, { ...mono, family: theme.fonts.monoBold, color: theme.colors.accent }) + gap;
          }
          kit.drawTracked(g, fitMono(g, ctx, l.msg, row.x + row.w - x, mono, cell), x, base, { ...mono, color });
        } else {
          const base = row.y + plan.textSize * 1.05;
          const x = row.x + pad;
          kit.drawTracked(g, fitMono(g, ctx, l.msg, row.x + row.w - x, mono, cell), x, base, { ...mono, color });
          const meta = [options.showUnits ? l.unit : '', options.showTime ? ctx.fmt.ago(l.t) : '', count].filter(Boolean).join(' · ');
          if (meta) kit.drawTracked(g, fitMono(g, ctx, meta, row.x + row.w - x, small, smallCell), x, base + plan.detailSize * 1.45, { ...small, color: theme.colors.inkDim });
        }
      });
      drawMore(g, ctx, plan, { indent: pad });
    });
  },
  demo: ({ now }) => ({ sources: demoSources(now) }),
});

/* Errors per minute -------------------------------------------------------------------------------- */

const rateOptions = t.object({
  units: units(),
  messages: messages(),
  includeWarnings: includeWarnings(false),
  historyMs: t.duration({
    default: 3600_000,
    min: 10 * 60_000,
    max: 24 * 3600_000,
    label: L('Span', 'Periodo', 'Zeitraum', '时间范围', '時間範圍'),
    help: L('How far back the curve goes (up to 24 h).', 'Hasta cuándo atrás llega la curva (hasta 24 h).', 'Wie weit die Kurve zurückreicht (bis 24 h).', '曲线回溯多久（最多 24 小时）。', '曲線回溯多久（最多 24 小時）。'),
  }),
  holdMs: holdMs(),
});

export const rate = defineWidget({
  id: 'rate',
  name: L('Errors per minute', 'Errores por minuto', 'Fehler pro Minute', '每分钟错误数', '每分鐘錯誤數'),
  description: L(
    'A curve of the errors in your logs, minute by minute, and how many there were.',
    'Una curva de los errores de tus logs, minuto a minuto, y cuántos hubo.',
    'Eine Kurve der Fehler in deinen Logs, Minute für Minute, und wie viele es waren.',
    '日志中错误数量的逐分钟曲线，以及总数。',
    '日誌中錯誤數量的逐分鐘曲線，以及總數。',
  ),
  icon: 'activity',
  category: 'system',
  tags: ['logs', 'errors'],
  size: { min: { w: 160, h: 80 }, preferred: { w: 480, h: 200 } },
  options: rateOptions,
  sources: [...SOURCE_IDS],
  redraw: 'minute',
  urgent,
  idle,
  // No log followed (off, failing or waiting) and no error kept: a flat zero would say nothing.
  empty: ({ sources }) => {
    const st = statuses(sources);
    return st.length > 0 && !st.some((s) => s.status.state === 'following') && !collect(sources, 'alerts').length;
  },
  render(g, ctx) {
    const { box, options, theme, kit, now } = ctx;
    const c = theme.colors;
    const view = { units: options.units, messages: options.messages };
    const alerts = collect(ctx.sources, 'alerts');
    const errors = select(alerts, { ...view, level: 'error' }).filter((l) => l.level === 'error');
    const warnings = options.includeWarnings ? select(alerts, { ...view, level: 'warning' }).filter((l) => l.level === 'warning') : [];
    const span = Math.max(10 * 60_000, options.historyMs);
    const total = errors.filter((l) => l.t > now - span).reduce((a, l) => a + l.count, 0);
    const fresh = !!freshError(ctx.sources, options, now);
    const side = box.w >= box.h * 2.2;
    // The number and what it counts: at the left of a wide tile, above the curve otherwise.
    const numH = side ? Math.min(box.h * 0.5, box.w * 0.16) : Math.min(box.h * 0.34, box.w * 0.22);
    // ctx.plural is Kiosko 0.2.6's; before it, the plural form is enough.
    const plural = (ctx as unknown as { plural?: (n: number, forms: Record<string, Record<string, string>>) => string }).plural;
    const forms = {
      en: { one: 'error in {span}', other: 'errors in {span}' },
      es: { one: 'error en {span}', other: 'errores en {span}' },
      de: { one: 'Fehler in {span}', other: 'Fehler in {span}' },
      'zh-Hans': { other: '{span}内的错误' },
      'zh-Hant': { other: '{span}內的錯誤' },
    };
    const label = (plural ? plural(total, forms) : ctx.t(Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, (v as { other: string }).other])) as Record<string, string> as never)).replace('{span}', ctx.fmt.duration(span, { compact: true })).replace('{n}', String(total));
    const big = { size: Math.round(numH), family: theme.fonts.sansBold, color: fresh ? c.alert : total ? c.ink : c.inkDim };
    const lab = { size: Math.max(9, Math.round(numH * 0.32)), family: theme.fonts.sans, color: c.inkDim };
    const colW = side ? Math.max(kit.measureTracked(g, String(total), big), Math.min(box.w * 0.3, kit.measureTracked(g, label, lab))) : box.w;
    clipped(g, ctx, () => {
      const nSize = kit.fitSize(g, String(total), colW, big, 10);
      kit.drawTracked(g, String(total), box.x, box.y + nSize * 0.92, { ...big, size: nSize });
      kit.drawTracked(g, kit.truncate(g, label, colW, lab), box.x, box.y + nSize * 0.92 + lab.size * 1.3, lab);
      const top = side ? box.y : box.y + nSize * 0.92 + lab.size * 1.9;
      const left = side ? box.x + colW + Math.max(10, box.w * 0.03) : box.x;
      const axis = { size: Math.max(8, Math.round(Math.min(box.h * 0.09, 18))), family: theme.fonts.sans, color: c.inkFaint };
      const curve = { x: left, y: top + axis.size * 1.2, w: box.x + box.w - left, h: box.y + box.h - top - axis.size * 2.6 };
      if (curve.w < 20 || curve.h < 10) return;
      // Buckets of a minute at least (shorter ones would turn 1 error into "2/min"), 5 px apart at least.
      const n = Math.max(10, Math.min(120, Math.floor(curve.w / 5), Math.floor(span / 60_000)));
      const ev = perMinute(errors, now, span, n);
      const wv = options.includeWarnings ? perMinute(warnings, now, span, n) : [];
      const max = Math.max(1, ...ev, ...wv);
      const ceil = max <= 5 ? Math.ceil(max) : Math.ceil(max / 5) * 5;
      const px = (i: number) => curve.x + (curve.w * i) / (n - 1);
      const py = (v: number) => curve.y + curve.h - (curve.h * v) / ceil;
      const path = (vals: number[]) => {
        g.beginPath();
        vals.forEach((v, i) => (i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v))));
      };
      g.strokeStyle = c.inkFaint;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(curve.x, curve.y + curve.h + 0.5);
      g.lineTo(curve.x + curve.w, curve.y + curve.h + 0.5);
      g.stroke();
      const series: [number[], string][] = [...(wv.length ? [[wv, c.warn] as [number[], string]] : []), [ev, c.alert]];
      for (const [vals, color] of series) {
        path(vals);
        g.lineTo(px(n - 1), curve.y + curve.h);
        g.lineTo(px(0), curve.y + curve.h);
        g.closePath();
        g.globalAlpha = 0.22;
        g.fillStyle = color;
        g.fill();
        g.globalAlpha = 1;
        path(vals);
        g.strokeStyle = color;
        g.lineWidth = Math.max(1.5, Math.min(3, curve.h / 40));
        g.lineJoin = 'round';
        g.stroke();
      }
      const perMin = ctx.t(L('{n}/min', '{n}/min', '{n}/min', '{n}/分钟', '{n}/分鐘')).replace('{n}', String(ceil));
      kit.drawTracked(g, perMin, curve.x, curve.y - axis.size * 0.3, axis);
      const bottom = curve.y + curve.h + axis.size * 1.25;
      kit.drawTracked(g, `−${ctx.fmt.duration(span, { compact: true })}`, curve.x, bottom, axis);
      kit.drawTracked(g, ctx.t(L('now', 'ahora', 'jetzt', '现在', '現在')), curve.x + curve.w, bottom, { ...axis, align: 'right' });
    });
  },
  demo: ({ now }) => ({ sources: demoSources(now) }),
});

/* The last error ---------------------------------------------------------------------------------- */

const lastOptions = t.object({
  units: units(),
  messages: messages(),
  includeWarnings: includeWarnings(false),
  holdMs: holdMs(),
});

/** The last error (or warning) the options let through, with its repeats counted. */
export function lastError(sources: Record<string, unknown>, o: { units: string[]; messages: string[]; includeWarnings: boolean }): LogLine | null {
  const worst: Level = o.includeWarnings ? 'warning' : 'error';
  const list = fold(select(collect(sources, 'alerts'), { units: o.units, messages: o.messages, level: worst }));
  const e = list[list.length - 1];
  if (!e) return null;
  // Warnings and errors are kept folded by the minute; the tail's lines fold the whole run of repeats.
  const run = collect(sources, 'lines').find((l) => l.t === e.t && l.msg === e.msg && l.unit === e.unit && l.kind === e.kind && l.level === e.level);
  return run && run.count > e.count ? { ...e, count: run.count, first: Math.min(run.first, e.first) } : e;
}

export const last = defineWidget({
  id: 'last-error',
  name: L('Last error', 'Último error', 'Letzter Fehler', '最近的错误', '最近的錯誤'),
  description: L(
    'The last error of your logs, big, with where and when: for a small tile.',
    'El último error de tus logs, en grande, con dónde y cuándo: para una tesela pequeña.',
    'Der letzte Fehler deiner Logs, groß, mit wo und wann: für eine kleine Kachel.',
    '日志中最近的一条错误，大字显示来源和时间：适合小格子。',
    '日誌中最近的一則錯誤，大字顯示來源與時間：適合小方格。',
  ),
  icon: 'octagon-alert',
  category: 'system',
  tags: ['logs', 'errors'],
  size: { min: { w: 160, h: 80 }, preferred: { w: 420, h: 200 } },
  options: lastOptions,
  sources: [...SOURCE_IDS],
  redraw: 'minute',
  urgent,
  idle,
  empty: ({ sources, options }) => delivered(sources) && !lastError(sources, options),
  render(g, ctx) {
    const { box, options, theme, kit, now } = ctx;
    const c = theme.colors;
    const e = lastError(ctx.sources, options);
    if (!e) return drawEmpty(g, ctx, emptyMessage(ctx, ctx.t(L('No errors', 'Sin errores', 'Keine Fehler', '没有错误', '沒有錯誤'))));
    const fresh = options.holdMs > 0 && now - e.t < options.holdMs;
    const color = fresh ? colorOf(ctx, e.level) : c.ink;
    const metaSize = Math.max(10, Math.round(Math.min(28, box.h * 0.15, box.w * 0.07)));
    const unitFont = { size: metaSize, family: theme.fonts.sansBold, color: fresh ? colorOf(ctx, e.level) : c.inkDim };
    const metaFont = { size: metaSize, family: theme.fonts.sans, color: c.inkDim };
    const rest = [ctx.fmt.ago(e.t), countLabel(e.count)].filter(Boolean).join(' · ');
    clipped(g, ctx, () => {
      const restW = kit.measureTracked(g, ` · ${rest}`, metaFont);
      const unit = kit.truncate(g, e.unit, Math.max(metaSize * 2, box.w - restW), unitFont);
      const uw = kit.drawTracked(g, unit, box.x, box.y + metaSize, unitFont);
      kit.drawTracked(g, kit.truncate(g, ` · ${rest}`, Math.max(0, box.w - uw), metaFont), box.x + uw, box.y + metaSize, metaFont);
      // The message as big as it fits whole, down to a size that can still be read; cut below that.
      const top = box.y + metaSize * 1.6;
      const room = box.y + box.h - top;
      const font = { size: 0, family: theme.fonts.sans, color };
      let size = Math.min(room * 0.5, box.w * 0.12, 72);
      const min = Math.max(10, Math.min(16, room / 3));
      let lines: string[] = [];
      for (let i = 0; i < 8; i++) {
        font.size = Math.max(min, Math.round(size));
        const max = Math.max(1, Math.floor(room / (font.size * 1.18)));
        lines = kit.wrapLines(g, e.msg, box.w, max, font);
        const whole = !lines[lines.length - 1]?.endsWith('…') || e.msg.endsWith('…');
        if (whole || font.size <= min) break;
        size *= 0.84;
      }
      lines.forEach((ln, i) => kit.drawTracked(g, ln, box.x, top + font.size * (0.95 + i * 1.18), font));
    });
  },
  demo: ({ now }) => ({ sources: demoSources(now) }),
});

export const WIDGETS = [tail, rate, last];
