const price = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const size = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtPrice = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : price.format(n);
export const fmtSize = (n: number | null | undefined) => (n == null ? '—' : size.format(n));
export const fmtUsd = (n: number | null | undefined) => (n == null ? '—' : usd.format(n));
export const fmtSigned = (n: number) => `${n >= 0 ? '+' : ''}${usd.format(n)}`;
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
