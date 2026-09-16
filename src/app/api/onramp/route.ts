import { z } from "zod";
import { handle, readJson } from "@/lib/api";
import { parseAmount } from "@/lib/amounts";
import { requireUser } from "@/lib/auth";
import { cardSchema } from "@/lib/fiat-stub";
import { createOnramp, listOnramps, processOnramp } from "@/lib/onramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  amount: z.string(),
  idempotencyKey: z.string().uuid(),
  card: cardSchema,
});

/** Create an onramp order and drive it as far as it will go in one round-trip. */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const { amount, idempotencyKey, card } = await readJson(req, body);
  const order = await createOnramp({ userAddress: user.address, amount: parseAmount(amount), idempotencyKey, card });
  const result = await processOnramp(order.id);
  return json({ order: serialize(result.order), inProgress: result.inProgress }, { status: 201 });
});

export const GET = handle(async (req) => {
  const user = await requireUser(req);
  return json({ orders: (await listOnramps(user.address)).map(serialize) });
});
