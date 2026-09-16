import { handle } from "@/lib/api";
import { addressFromPublicKey, linkedCookieHeader, linkedWallets, webAuthnHandler } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called right after a passkey ceremony: records the session's credential in the
 * signed linked-wallets cookie so later switches to it need no new prompt.
 */
export const POST = handle(async (req) => {
  const session = await webAuthnHandler().getSession(req);
  if (!session) throw new HttpError(401, "No passkey session");
  const address = addressFromPublicKey(session.publicKey);
  const others = linkedWallets(req).filter((w) => w.a !== address);
  const wallets = [...others, { a: address, c: session.credentialId }];
  const res = json({ wallets: wallets.map((w) => w.a) });
  res.headers.set("Set-Cookie", linkedCookieHeader(wallets));
  return res;
});
