import { reopenOrder } from "@/lib/admin";
import { handle, requireUuid } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Operator: move a `needs_review` order back onto its automated path (fresh attempt). */
export const POST = handle<{ kind: string; id: string }>(async (req, { params }) => {
  if (!isAdminRequest(req)) throw new HttpError(401, "Admin sign-in required");
  const { kind, id: raw } = await params;
  if (kind !== "onramp" && kind !== "offramp") throw new HttpError(404, "Order not found");
  const order = await reopenOrder(kind, requireUuid(raw));
  if (!order) throw new HttpError(409, "Order is not in needs_review");
  return json({ order: serialize(order) });
});
