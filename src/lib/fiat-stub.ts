import { z } from "zod";

/**
 * Stubbed USD rails. Per the assignment, fiat flows are fake: we validate the
 * shape of the payment credentials and then assume the money moves.
 *
 * References are deterministic per order so a replayed step yields the same
 * ref (idempotent), and every function is side-effect free apart from a log.
 */

function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export const cardSchema = z.object({
  name: z.string().trim().min(2).max(64),
  number: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^\d{13,19}$/, "Card number must be 13–19 digits").refine(luhn, "Card number failed checksum")),
  exp: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "Use MM/YY"),
  cvc: z.string().regex(/^\d{3,4}$/, "3–4 digits"),
});
export type Card = z.infer<typeof cardSchema>;

export const bankSchema = z.object({
  accountName: z.string().trim().min(2).max(64),
  routing: z.string().regex(/^\d{9}$/, "9-digit routing number"),
  account: z.string().regex(/^\d{6,17}$/, "6–17 digit account number"),
});
export type Bank = z.infer<typeof bankSchema>;

export async function capturePayment(p: { orderId: string; amount: bigint; last4?: string }) {
  console.log(`[fiat-stub] capture ${p.amount} for order ${p.orderId} (card •••• ${p.last4 ?? "????"})`);
  return { ref: `cap_${p.orderId.slice(0, 8)}` };
}

export async function refundPayment(p: { orderId: string; amount: bigint; paymentRef: string | null }) {
  console.log(`[fiat-stub] refund ${p.amount} for order ${p.orderId} (${p.paymentRef ?? "no ref"})`);
  return { ref: `rf_${p.orderId.slice(0, 8)}` };
}

export async function creditPayout(p: { orderId: string; amount: bigint; last4?: string }) {
  console.log(`[fiat-stub] payout ${p.amount} for order ${p.orderId} (acct •••• ${p.last4 ?? "????"})`);
  return { ref: `po_${p.orderId.slice(0, 8)}` };
}
