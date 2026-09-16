import { orderIdToBigInt } from "./memo";

/**
 * Tempo 2D nonces make issuer transactions idempotent per (order, attempt):
 *
 *   nonceKey = (uuid128 << 8) | attempt,  nonce = 0
 *
 * A given key can only ever have its nonce 0 consumed once, so the protocol —
 * not our database — guarantees at-most-one inclusion per attempt. Different
 * orders never share a key, so concurrent serverless invocations never
 * collide, and a retry after an *unknown* outcome safely reuses the key:
 * either it lands (the first never did) or it is rejected as "nonce too low"
 * (the first landed; recover its hash by memo).
 *
 * Bits: uuid occupies bits 8..135 — far below the reserved 0x5b-prefixed and
 * maxUint256 (expiring) keys. Key 0 (protocol nonce) is reserved for ops scripts.
 */
export function nonceKeyFor(orderId: string, attempt: number): bigint {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 255) {
    throw new Error(`attempt out of range: ${attempt}`);
  }
  return (orderIdToBigInt(orderId) << 8n) | BigInt(attempt);
}
