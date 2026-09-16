import { handle } from "@/lib/api";
import { addressFromPublicKey, clearLinkedCookieHeader, linkedCookieHeader, linkedWalletsAnySession, webAuthnHandler } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called right after a passkey ceremony: records the session's credential in the
 * signed linked-wallets cookie (bound to this session) so later switches to it
 * need no new prompt. Existing entries are carried over and re-bound.
 */
export const POST = handle(async (req) => {
  const session = await webAuthnHandler().getSession(req);
  if (!session) throw new HttpError(401, "No passkey session");
  const address = addressFromPublicKey(session.publicKey);
  const others = linkedWalletsAnySession(req).filter((w) => w.a !== address);
  const wallets = [...others, { a: address, c: session.credentialId, t: Math.floor(Date.now() / 1000) }];
  const res = json({ wallets: wallets.map((w) => w.a) });
  res.headers.set("Set-Cookie", linkedCookieHeader(req, wallets));
  return res;
});

/** Sign-out: forget every linked wallet in this browser. */
export const DELETE = handle(async () => {
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", clearLinkedCookieHeader());
  return res;
});
