import { webAuthnHandler } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Passkey register/login/logout ceremonies (accounts/server), backed by Postgres.
 * Behind a TLS-terminating proxy (Docker, most hosts) Node sees http://; the handler
 * only marks its session cookie `Secure` when the request URL is https, so restore
 * the public scheme from x-forwarded-proto before handing the request over.
 */
function forwarded(req: Request): Request {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto !== "https" || req.url.startsWith("https://")) return req;
  return new Request(req.url.replace(/^http:\/\//, "https://"), req);
}

export const GET = (req: Request) => webAuthnHandler().fetch(forwarded(req));
export const POST = (req: Request) => webAuthnHandler().fetch(forwarded(req));
