import { z } from "zod";
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { pendingLabelKey } from "@/lib/identity";
import { pgKv } from "@/lib/kv-postgres";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Add a wallet": the passkey ceremony's `name` must stay the username (it's what
 * the OS shows as the passkey's label), so the wallet's own label is parked here
 * for a few minutes and picked up by `onRegister` when the new credential lands.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const { label } = await readJson(req, z.object({ label: z.string().trim().min(1).max(40) }));
  await pgKv.set(pendingLabelKey(user.credentialId), label, { ttl: 600 });
  return json({ ok: true });
});
