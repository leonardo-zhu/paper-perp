/**
 * Fixed-point helpers. Prices and sizes travel as decimal strings and are
 * signed as integers scaled by 1e8 (EIP-712 has no decimal type). Scaling
 * goes through bigint so "0.1" never turns into 0.1000000000000000055.
 */
export const E8_DECIMALS = 8;
const E8 = 10n ** 8n;
const DECIMAL_RE = /^(\d+)(?:\.(\d{1,8}))?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

export function toE8(value: string | number): bigint {
  const str = typeof value === 'number' ? value.toFixed(E8_DECIMALS) : value.trim();
  const match = DECIMAL_RE.exec(str);
  if (!match) throw new Error(`invalid decimal: ${value}`);
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? '').padEnd(E8_DECIMALS, '0'));
  return whole * E8 + frac;
}

export function fromE8(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / E8;
  const frac = (abs % E8).toString().padStart(E8_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function e8ToNumber(value: bigint): number {
  return Number(fromE8(value));
}

/** True when `value` is an exact multiple of `step` (both decimal strings). */
export function isMultipleOf(value: string, step: string): boolean {
  const s = toE8(step);
  return s > 0n && toE8(value) % s === 0n;
}

/** Round a float to `decimals` places to keep accumulated PnL readable. */
export function round(value: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Number of decimal places implied by a step such as "0.001" → 3. */
export function decimalsOf(step: string): number {
  const idx = step.indexOf('.');
  return idx === -1 ? 0 : step.length - idx - 1;
}
