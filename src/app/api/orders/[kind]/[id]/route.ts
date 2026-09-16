import { handle, requireUuid } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { getOfframp } from "@/lib/offramp";
import { getOnramp } from "@/lib/onramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle<{ kind: string; id: string }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { kind, id: raw } = await params;
  const id = requireUuid(raw);
  const order = kind === "onramp" ? await getOnramp(id, user.address) : kind === "offramp" ? await getOfframp(id, user.address) : null;
  if (!order) throw new HttpError(404, "Order not found");
  return json({ order: serialize(order) });
});
