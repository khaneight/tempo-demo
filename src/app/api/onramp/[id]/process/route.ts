import { handle, requireUuid } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { getOnramp, processOnramp } from "@/lib/onramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Idempotent "Retry / Check status". Safe to call any number of times. */
export const POST = handle<{ id: string }>(async (req, { params }) => {
  const user = await requireUser(req);
  const id = requireUuid((await params).id);
  const order = await getOnramp(id, user.address);
  if (!order) throw new HttpError(404, "Order not found");
  const result = await processOnramp(id);
  return json({ order: serialize(result.order), inProgress: result.inProgress });
});
