import { computeLiabilities } from "@/lib/admin";
import { handle } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { json } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  if (!isAdminRequest(req)) throw new HttpError(401, "Admin sign-in required");
  return json(await computeLiabilities());
});
