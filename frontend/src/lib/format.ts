export function money(usd: number, digits = 2): string {
  const v = Number.isFinite(usd) ? usd : 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact money for KPIs: $41, $1.2k */
export function moneyShort(usd: number): string {
  if (usd >= 10000) return '$' + (usd / 1000).toFixed(0) + 'k';
  if (usd >= 1000) return '$' + (usd / 1000).toFixed(1) + 'k';
  if (usd >= 100) return '$' + Math.round(usd);
  if (usd >= 10) return '$' + Math.round(usd);
  return '$' + (Math.round(usd * 10) / 10).toString();
}

/** 2h 14m · 5h 02m · 18m · 45s */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return m < 10 && rest ? `${m}m ${String(rest).padStart(2, '0')}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function toMs(iso: string): number {
  const t = Date.parse(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(t) ? Date.now() : t;
}

/** 12s · 2m · 1h · 1d */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.max(0, Math.round((now - toMs(iso)) / 1000));
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(toMs(iso)).toLocaleDateString();
}

export function clock(iso: string, seconds = false): string {
  const d = new Date(toMs(iso));
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!seconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function compactNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export function numberWord(n: number, lower = false): string {
  const w = n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  return lower ? w.toLowerCase() : w;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "−4" with a real minus sign */
export function minus(n: number): string {
  return '−' + Math.abs(n);
}
