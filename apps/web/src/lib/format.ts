const formatters = new Map<number, Intl.NumberFormat>();
/** Fixed-decimal formatter, cached per precision. */
function fixed(dp: number): Intl.NumberFormat {
  let f = formatters.get(dp);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    formatters.set(dp, f);
  }
  return f;
}

/** `dp` should come from the market's tick size (priceDecimals). */
export const fmtPrice = (n: number | null | undefined, dp = 1) =>
  n == null || !Number.isFinite(n) ? '—' : fixed(dp).format(n);
/** `dp` should come from the market's step size (sizeDecimals). */
export const fmtSize = (n: number | null | undefined, dp = 3) =>
  n == null ? '—' : fixed(dp).format(n);
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : fixed(2).format(n));
export const fmtSigned = (n: number) => `${n >= 0 ? '+' : ''}${fixed(2).format(n)}`;
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
