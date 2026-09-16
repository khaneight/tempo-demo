import { ZodError, type ZodType } from "zod";
import { AmountError } from "./amounts";
import { HttpError } from "./http-error";
import { NotFoundError, OrderLockedError } from "./orders-db";
import { json } from "./serialize";

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (req: Request, ctx: Ctx<P>) => Promise<Response>;

/** Uniform error mapping for route handlers. */
export function handle<P = Record<string, never>>(fn: Handler<P>): Handler<P> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
      if (err instanceof OrderLockedError) return json({ error: err.message, inProgress: true }, { status: 409 });
      if (err instanceof NotFoundError) return json({ error: err.message }, { status: 404 });
      if (err instanceof AmountError) return json({ error: err.message }, { status: 400 });
      if (err instanceof ZodError) {
        const first = err.issues[0];
        return json({ error: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input" }, { status: 400 });
      }
      console.error("[api]", err);
      return json({ error: "Something went wrong. Your order is safe — try again." }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request, schema: ZodType<T>, opts: { optional?: boolean } = {}): Promise<T> {
  const text = await req.text();
  if (opts.optional && text.trim() === "") return schema.parse({});
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(body);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids hit uuid columns; reject junk as 404 instead of letting Postgres 22P02 become a 500. */
export function requireUuid(id: string): string {
  if (!UUID.test(id)) throw new HttpError(404, "Order not found");
  return id.toLowerCase();
}

/** Best-effort client identifier for throttling (Vercel/proxies set x-forwarded-for). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
