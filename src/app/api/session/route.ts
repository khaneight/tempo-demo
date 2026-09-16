import { getSessionUser } from "@/lib/auth";
import { handle } from "@/lib/api";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const user = await getSessionUser(req);
  return json({ user });
});
