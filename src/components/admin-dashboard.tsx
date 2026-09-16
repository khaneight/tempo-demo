"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAmount } from "@/lib/amounts";
import { api } from "@/lib/api-client";
import { addressUrl, short } from "@/lib/client-config";
import { StatusBadge } from "@/components/order-status";

type S = string; // bigint serialized
type Data = {
  chain: { totalSupply: S; treasuryBalance: S; feeAmmBalance: S };
  users: { address: string; balance: S; createdAt: string }[];
  fiat: { reservesHeld: S; tokensOwed: S; fiatOwed: S; pendingBurns: S; expectedSupply: S };
  counts: { onramp: Record<string, number>; offramp: Record<string, number> };
  reconciliation: { supplyDrift: S; unattributedTreasury: S; heldByOutsiders: S };
  needsReview: { onramp: { id: string; amount: S; status: string; lastError: string | null; userAddress: string }[]; offramp: { id: string; amount: S; status: string; lastError: string | null; userAddress: string }[] };
};

const usd = (v: S) => `$${formatAmount(BigInt(v))}`;
const tok = (v: S) => `${formatAmount(BigInt(v))} AcmeUSD`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Recon({ label, value, expectZero, explain }: { label: string; value: S; expectZero?: boolean; explain: string }) {
  const zero = BigInt(value) === 0n;
  const ok = expectZero ? zero : true;
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${ok ? "border-emerald-300 bg-emerald-50/50" : "border-red-300 bg-red-50/50"}`}>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{explain}</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm tabular-nums">{tok(value)}</div>
        <Badge variant={ok ? "default" : "destructive"}>{expectZero ? (ok ? "balanced" : "DRIFT") : "info"}</Badge>
      </div>
    </div>
  );
}

export function AdminDashboard({ data }: { data: Data }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState<string | null>(null);
  const userTotal = data.users.reduce((a, u) => a + BigInt(u.balance), 0n);

  async function reprocess() {
    setBusy(true);
    try {
      const r = await api<{ processed: number; results: { kind: string; id: string; before: string; after: string }[] }>("/api/admin/reprocess", { method: "POST" });
      setSweep(r.processed === 0 ? "No stuck orders." : r.results.map((x) => `${x.kind} ${x.id.slice(0, 8)}: ${x.before} → ${x.after}`).join("\n"));
      router.refresh();
    } catch (e) {
      setSweep((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reopen(kind: "onramp" | "offramp", id: string) {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${kind}/${id}/reopen`, { method: "POST" });
      setSweep(`${kind} ${id.slice(0, 8)} reopened — it will be re-driven by the user's page or the next sweep`);
      router.refresh();
    } catch (e) {
      setSweep((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/api/admin/login", { method: "DELETE" });
    router.push("/admin/login");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">ACME liabilities</h1>
          <p className="text-sm text-muted-foreground">Live from Tempo testnet + the order ledger.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.refresh()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          <Button onClick={reprocess} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Reprocess stuck orders</Button>
          <Button variant="ghost" onClick={logout}>Sign out</Button>
        </div>
      </div>
      {sweep && <pre className="whitespace-pre-wrap rounded-lg border bg-muted p-3 text-xs">{sweep}</pre>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="AcmeUSD in circulation (user liabilities)" value={tok(data.chain.totalSupply)} sub="on-chain totalSupply" />
        <Stat label="USD reserves held (corporate)" value={usd(data.fiat.reservesHeld)} sub="Σ onramps minted − Σ offramps paid out" />
        <Stat label="Held by known users" value={tok(userTotal.toString())} sub={`${data.users.length} wallets`} />
        <Stat label="Treasury balance" value={tok(data.chain.treasuryBalance)} sub="awaiting burn / unattributed" />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tokens owed to users" value={tok(data.fiat.tokensOwed)} sub="USD captured, mint pending" />
        <Stat label="USD owed to users" value={usd(data.fiat.fiatOwed)} sub="transfer verified, payout pending" />
        <Stat label="Pending burns" value={tok(data.fiat.pendingBurns)} sub="paid out, burn pending" />
        <Stat label="Fee revenue in Fee AMM" value={tok(data.chain.feeAmmBalance)} sub="network fees users paid in AcmeUSD; ACME is the LP" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reconciliation</CardTitle>
          <CardDescription>Chain vs. ledger. Anything non-zero in a “balanced” row is a bug or an operator task.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Recon label="Supply drift" value={data.reconciliation.supplyDrift} expectZero explain={`totalSupply − (Σ minted − Σ burned); expected supply ${tok(data.fiat.expectedSupply)}. Non-zero = issuance outside the ledger`} />
          <Recon label="Unattributed treasury deposits" value={data.reconciliation.unattributedTreasury} expectZero explain="treasury balance − pending burns; non-zero = deposits without a valid order (see needs review)" />
          <Recon label="Held outside known users" value={data.reconciliation.heldByOutsiders} explain="Σ user balances + treasury + Fee AMM − totalSupply; AcmeUSD sent to wallets not registered here" />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Orders by status</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            {(["onramp", "offramp"] as const).map((k) => (
              <div key={k}>
                <div className="mb-1 font-medium capitalize">{k}</div>
                {Object.entries(data.counts[k]).length === 0 && <div className="text-muted-foreground">—</div>}
                {Object.entries(data.counts[k]).map(([s, n]) => (
                  <div key={s} className="flex items-center justify-between py-0.5"><StatusBadge status={s as never} /><span className="tabular-nums">{n}</span></div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Needs review</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.needsReview.onramp.length + data.needsReview.offramp.length === 0 && <p className="text-muted-foreground">Nothing — all orders resolved automatically.</p>}
            {[...data.needsReview.onramp.map((o) => ({ ...o, kind: "onramp" as const })), ...data.needsReview.offramp.map((o) => ({ ...o, kind: "offramp" as const }))].map((o) => (
              <div key={o.id} className="rounded border p-2">
                <div className="flex justify-between"><span className="font-medium capitalize">{o.kind} · {tok(o.amount)}</span><span className="font-mono text-xs">{short(o.userAddress)}</span></div>
                <div className="text-xs text-muted-foreground">{o.lastError}</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">{o.id}</div>
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => reopen(o.kind, o.id)}>Reopen (retry with fresh attempt)</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">User balances (on-chain)</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Wallet</TableHead><TableHead>Joined</TableHead><TableHead className="text-right">AcmeUSD</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.users.map((u) => (
                <TableRow key={u.address}>
                  <TableCell className="font-mono text-xs"><a href={addressUrl(u.address)} target="_blank" rel="noreferrer" className="underline decoration-dotted">{u.address}</a></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(BigInt(u.balance))}</TableCell>
                </TableRow>
              ))}
              {data.users.length === 0 && <TableRow><TableCell colSpan={3} className="text-muted-foreground">No users yet.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
