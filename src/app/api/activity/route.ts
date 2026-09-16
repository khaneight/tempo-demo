import { getActivity } from "@/lib/activity";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Unified wallet timeline: deposits, withdrawals, sends, receives, fees. */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const { rows, syncedBlock } = await getActivity(user.address);
  return json({ rows, syncedBlock });
});
