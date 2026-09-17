import { handle } from "@/lib/api";
import { usernameAvailable } from "@/lib/identity";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live username check for the registration form. */
export const GET = handle(async (req) => {
  const username = new URL(req.url).searchParams.get("username") ?? "";
  return json(await usernameAvailable(username));
});
