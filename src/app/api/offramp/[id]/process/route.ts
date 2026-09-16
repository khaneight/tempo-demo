import { z } from "zod";
import { handle, readJson, requireUuid } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { getOfframp, processOfframp } from "@/lib/offramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() });

/**
 * Submit the transfer hash after signing, or just "Check status" (memo lookup).
 * Idempotent: verification, credit and burn each happen at most once.
 */
export const POST = handle<{ id: string }>(async (req, { params }) => {
  const user = await requireUser(req);
  const id = requireUuid((await params).id);
  const order = await getOfframp(id, user.address);
  if (!order) throw new HttpError(404, "Order not found");
  const { txHash } = await readJson(req, body, { optional: true });
  const result = await processOfframp(id, { txHash: txHash as `0x${string}` | undefined });
  return json({ order: serialize(result.order), inProgress: result.inProgress, message: result.message });
});
