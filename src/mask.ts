/**
 * Secrets and personal data out of a log line before it is kept, shown or
 * sent to the editor: passwords in URLs, bearer and basic credentials,
 * `token=…`/`"password": "…"` pairs, the well-known token formats (GitHub,
 * GitLab, Slack, AWS, Google, OpenAI-style `sk-…`, JWTs, private keys) and
 * e-mail addresses. What is masked becomes `***`.
 *
 * It errs on the side of hiding: a panel on a shelf is seen by anyone
 * passing by, and a log line is not worth a leaked key.
 */

export const MASK = '***';

/** Names of values that are secrets, as they appear in `key=value`, `key: value` and JSON. */
const SECRET_KEY = String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|session(?:[_-]?id)?|sessid|cookie|set-cookie|x-api-key|signature|sig|credentials?)`;

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // -----BEGIN … PRIVATE KEY----- blocks (one line once joined).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `${MASK} private key ${MASK}`],
  // scheme://user:password@host → scheme://user:***@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]*):[^\s@/'"]+@/gi, (_m, pre) => `${pre}:${MASK}@`],
  // Authorization: Bearer xyz / Basic xyz / token xyz
  // (only what looks like a credential: 8 characters or more, with a digit, a symbol or a lower-upper pair in it)
  [/\b([Bb]earer|BEARER|[Bb]asic|BASIC|[Dd]igest)(\s+)(?=[A-Za-z0-9._~+/=-]*(?:[0-9._~+/=-]|[a-z][A-Z]))[A-Za-z0-9._~+/=-]{8,}/g, (_m, scheme, sp) => `${scheme}${sp}${MASK}`],
  [/\b(authorization\s*[:=]\s*token)(\s+)\S+/gi, (_m, pre, sp) => `${pre}${sp}${MASK}`],
  // "password": "…" (JSON, with or without escaped quotes)
  [new RegExp(String.raw`((?:\\?["'])${SECRET_KEY}(?:\\?["'])\s*:\s*(?:\\?["']))(?:[^"'\\]|\\(?!["']))*`, 'gi'), (_m, pre) => `${pre}${MASK}`],
  // password=…, token: …, ?api_key=…&
  [new RegExp(String.raw`(\b[\w.-]*${SECRET_KEY}\b\s*[=:]\s*)(?!${MASK.replace(/\*/g, '\\*')})("[^"]*"|'[^']*'|[^\s&,;"'<>)\]}]+)`, 'gi'), (_m, pre) => `${pre}${MASK}`],
  // Well-known token formats, wherever they are.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|gl(?:dt|rt|soat|ptt)-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}|[rp]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36})\b/g, MASK],
  // JSON Web Tokens: three base64url parts, the first two starting with {" encoded.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, `${MASK}@${MASK}`],
];

/** The line with its secrets and e-mail addresses replaced by `***`. */
export function mask(line: string): string {
  let out = line;
  for (const [re, by] of RULES) out = out.replace(re, by as never);
  return out;
}
