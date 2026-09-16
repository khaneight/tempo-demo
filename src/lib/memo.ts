import type { Hex } from "viem";

/**
 * Order id (UUID) <-> bytes32 memo used on every on-chain op for that order.
 * Left-padded 16-byte UUID; unique per order by construction and decodable
 * from an explorer.
 */
export function memoFromOrderId(id: string): Hex {
  const raw = id.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) throw new Error(`not a uuid: ${id}`);
  return `0x${raw.padStart(64, "0")}` as Hex;
}

export function orderIdFromMemo(memo: Hex): string {
  const raw = memo.slice(2).toLowerCase().slice(32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** UUID as a 128-bit integer; feeds the per-order nonce key. */
export function orderIdToBigInt(id: string): bigint {
  return BigInt(`0x${id.replaceAll("-", "")}`);
}
