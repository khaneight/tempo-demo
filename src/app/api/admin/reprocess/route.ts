import { timingSafeEqual } from "node:crypto";
import { reprocessStuck } from "@/lib/admin";
import { handle } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http-error";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function hasCronSecret(req: Request) {
  const secret = env().CRON_SECRET;
  const bearer = req.headers.get("authorization") ?? "";
  if (!secret) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sweep() {
  const results = await reprocessStuck();
  return json({ processed: results.length, results });
}

/** Vercel cron: GET with the bearer secret only (a Lax cookie must not trigger it via cross-site navigation). */
export const GET = handle(async (req) => {
  if (!hasCronSecret(req)) throw new HttpError(401, "Cron secret required");
  return sweep();
});

/** Admin button: POST with the admin cookie. */
export const POST = handle(async (req) => {
  if (!isAdminRequest(req) && !hasCronSecret(req)) throw new HttpError(401, "Admin sign-in required");
  return sweep();
});
