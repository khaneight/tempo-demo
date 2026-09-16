import { z } from "zod";
import { clientIp, handle, readJson } from "@/lib/api";
import { ADMIN_COOKIE, ADMIN_TTL_S, adminCookieValue, checkAdminPassword } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { pgKv } from "@/lib/kv-postgres";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FAILURES = 5;
const WINDOW_S = 15 * 60;

/** Shared-password login is brute-forceable without this: 5 failures per IP per 15 min. */
async function throttle(ip: string) {
  const key = `admin-login-fail:${ip}`;
  const n = (await pgKv.get<number>(key)) ?? 0;
  if (n >= MAX_FAILURES) throw new HttpError(429, "Too many attempts — try again in 15 minutes");
  return {
    fail: () => pgKv.set(key, n + 1, { ttl: WINDOW_S }),
    ok: () => pgKv.delete(key),
  };
}

export const POST = handle(async (req) => {
  const { password } = await readJson(req, z.object({ password: z.string().max(256) }));
  const t = await throttle(clientIp(req));
  if (!checkAdminPassword(password)) {
    await t.fail();
    throw new HttpError(401, "Wrong password");
  }
  await t.ok();
  const res = json({ ok: true });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.headers.set("Set-Cookie", `${ADMIN_COOKIE}=${adminCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_TTL_S}${secure}`);
  return res;
});

export const DELETE = handle(async () => {
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
});
