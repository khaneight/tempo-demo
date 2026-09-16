import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listOfframps } from "@/lib/offramp";
import { listOnramps } from "@/lib/onramp";
import { json, serialize } from "@/lib/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const [onramps, offramps] = await Promise.all([listOnramps(user.address), listOfframps(user.address)]);
  return json({ onramps: onramps.map(serialize), offramps: offramps.map(serialize) });
});
