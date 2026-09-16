import { z } from "zod";
import { handle, readJson } from "@/lib/api";
import { FEE_BUFFER, formatAmount, parseAmount } from "@/lib/amounts";
import { requireUser } from "@/lib/auth";
import { chain } from "@/lib/chain";
import { bankSchema } from "@/lib/fiat-stub";
import { HttpError } from "@/lib/http-error";
import { createOfframp, listOfframps } from "@/lib/offramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ amount: z.string(), bank: bankSchema });

/**
 * Create an offramp order. Returns the memo + treasury the client must use
 * for its on-chain transfer. Nothing moves until the transfer is verified.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const { amount: raw, bank } = await readJson(req, body);
  const amount = parseAmount(raw);
  const ch = chain();
  const balance = await ch.balanceOf(user.address);
  if (balance < amount + FEE_BUFFER) {
    throw new HttpError(400, `Insufficient balance: you have ${formatAmount(balance)} AcmeUSD and need ${formatAmount(FEE_BUFFER)} extra for fees`);
  }
  const order = await createOfframp({ userAddress: user.address, amount, bank });
  return json({ order: serialize(order), treasury: ch.treasury, token: ch.token }, { status: 201 });
});

export const GET = handle(async (req) => {
  const user = await requireUser(req);
  return json({ orders: (await listOfframps(user.address)).map(serialize) });
});
