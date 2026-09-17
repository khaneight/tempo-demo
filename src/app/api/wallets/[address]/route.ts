import { z } from "zod";
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { renameWalletLabel } from "@/lib/identity";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rename one of the identity's wallets. */
export const PATCH = handle<{ address: string }>(async (req, { params }) => {
  const user = await requireUser(req);
  const { address } = await params;
  const { label } = await readJson(req, z.object({ label: z.string().trim().min(1).max(40) }));
  const row = await renameWalletLabel(user.identityId, address, label);
  if (!row) throw new HttpError(404, "Wallet not found");
  return json({ wallet: { address: row.address, label: row.label } });
});
