import { getSessionUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { walletsOf } from "@/lib/identity";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who am I (for the wallet named by `x-wallet`, if any) and which wallets does my identity own. */
export const GET = handle(async (req) => {
  const user = await getSessionUser(req);
  if (!user) return json({ user: null, identity: null });
  const wallets = await walletsOf(user.identityId);
  return json({
    user: { address: user.address, credentialId: user.credentialId },
    identity: { username: user.username, wallets: wallets.map((w) => ({ address: w.address, credentialId: w.credentialId, label: w.label })) },
  });
});
