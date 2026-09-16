import { formatUnits, parseUnits } from "viem";

export const DECIMALS = 6;
/** 1.00 AcmeUSD */
export const MIN_ORDER = 1_000_000n;
/** 10,000.00 AcmeUSD */
export const MAX_ORDER = 10_000_000_000n;
/** Kept back on offramp/send so the user can still pay the AcmeUSD fee. */
export const FEE_BUFFER = 50_000n; // 0.05

export class AmountError extends Error {}

/**
 * The ONLY place a user-supplied decimal string becomes base units.
 * Rejects malformed input and more than 6 fractional digits.
 */
export function parseAmount(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new AmountError("Enter an amount with up to 6 decimal places");
  const v = parseUnits(s, DECIMALS);
  if (v < MIN_ORDER) throw new AmountError(`Minimum is ${formatAmount(MIN_ORDER)}`);
  if (v > MAX_ORDER) throw new AmountError(`Maximum is ${formatAmount(MAX_ORDER)}`);
  return v;
}

export function formatAmount(v: bigint): string {
  const [whole, frac = ""] = formatUnits(v, DECIMALS).split(".");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${w}.${frac.padEnd(2, "0").slice(0, Math.max(2, frac.length))}`;
}
