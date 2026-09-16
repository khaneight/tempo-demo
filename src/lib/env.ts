import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

/**
 * Server-only environment. Parsed lazily so the client bundle never touches it
 * and so build-time (e.g. `next build` on Vercel) doesn't require secrets.
 */
const serverSchema = z.object({
  /** Either name works; the Vercel Neon integration is configured with the TEMPO_ prefix. */
  TEMPO_DATABASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().url().optional(),
  ISSUER_PRIVATE_KEY: hex.refine((s) => s.length === 66, "32-byte key").transform((s) => s as `0x${string}`),
  ACME_USD_ADDRESS: address,
  TOKEN_DEPLOY_BLOCK: z.coerce.bigint().default(0n),
  TEMPO_RPC_URL: z.string().url().default("https://rpc.moderato.tempo.xyz"),
  /** Token the issuer pays its own fees in (pathUSD by default, faucet-funded). */
  ISSUER_FEE_TOKEN: address.default("0x20c0000000000000000000000000000000000000"),
  RP_ID: z.string().min(1).optional(),
  ORIGIN: z.string().url().optional(),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  CRON_SECRET: z.string().min(1).optional(),
  /** Test-only fault injection: mint_unknown | mint_revert | burn_unknown */
  CHAOS: z.string().optional(),
}).refine((e) => e.TEMPO_DATABASE_URL || e.DATABASE_URL, { message: "Set TEMPO_DATABASE_URL or DATABASE_URL" });

export type ServerEnv = Omit<z.infer<typeof serverSchema>, "RP_ID" | "ORIGIN"> & { RP_ID: string; ORIGIN: string };

/**
 * WebAuthn relying party. Explicit RP_ID/ORIGIN win; on Vercel they default to the
 * deployment's own URL (production domain for production, the preview URL for previews)
 * so passkeys work on every deployment without per-branch config. Locally: localhost.
 */
function relyingParty(e: z.infer<typeof serverSchema>): { RP_ID: string; ORIGIN: string } {
  // Previews use the stable branch alias (VERCEL_BRANCH_URL) so passkeys survive redeploys of the branch;
  // production uses the production domain.
  const vercelHost =
    process.env.VERCEL_ENV === "production"
      ? (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL)
      : (process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL);
  const ORIGIN = e.ORIGIN ?? (vercelHost ? `https://${vercelHost}` : "http://localhost:3000");
  const RP_ID = e.RP_ID ?? new URL(ORIGIN).hostname;
  return { RP_ID, ORIGIN };
}

/** Vercel's UI happily saves empty values; treat "" as unset so optional vars fall back and required ones say "missing". */
export function withoutBlanks(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && v.trim() !== "") out[k] = v.trim();
  return out;
}

let cached: ServerEnv | undefined;
export function env(): ServerEnv {
  if (!cached) {
    const result = serverSchema.safeParse(withoutBlanks(process.env));
    if (!result.success) {
      const problems = result.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
      throw new Error(`Invalid server environment — ${problems}`);
    }
    cached = { ...result.data, ...relyingParty(result.data) };
  }
  return cached;
}
