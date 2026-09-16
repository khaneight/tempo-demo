"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Identicon } from "@/components/identicon";
import { StatusBadge } from "@/components/order-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAmount } from "@/lib/amounts";
import { api } from "@/lib/api-client";
import { addressUrl, short } from "@/lib/client-config";

type S = string; // bigint serialized
export type AdminData = {
  chain: { totalSupply: S; treasuryBalance: S; feeAmmBalance: S };
  users: { address: string; balance: S; createdAt: string }[];
  unknownHolders: { address: string; balance: S }[];
  unknownTotal: S;
  holdersSyncedBlock: S;
  fetchedAt: number;
  fiat: { reservesHeld: S; tokensOwed: S; fiatOwed: S; pendingBurns: S; expectedSupply: S };
  counts: { onramp: Record<string, number>; offramp: Record<string, number> };
  reconciliation: { supplyDrift: S; unattributedTreasury: S; heldByOutsiders: S };
  needsReview: { onramp: { id: string; amount: S; status: string; lastError: string | null; userAddress: string }[]; offramp: { id: string; amount: S; status: string; lastError: string | null; userAddress: string }[] };
};

const usd = (v: S) => `$${formatAmount(BigInt(v))}`;
const tok = (v: S) => `${formatAmount(BigInt(v))} AcmeUSD`;
const REFRESH_MS = 15_000;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-lg font-semibold tabular-nums">{value}</div>
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

export function AdminDashboard({ initial }: { initial: AdminData }) {
  const router = useRouter();
  const qc = useQueryClient();
  // Times are rendered only after hydration (locale/tz/"now" differ between server and client).
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const q = useQuery({
    queryKey: ["admin-liabilities"],
    queryFn: () => api<AdminData>("/api/admin/liabilities"),
    initialData: initial,
    initialDataUpdatedAt: initial.fetchedAt,
    staleTime: REFRESH_MS, // the server-rendered snapshot is fresh; don't refetch immediately on mount
    // Keep it live: poll, and refetch whenever the tab regains focus or the network comes back.
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const data = q.data;
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState<string | null>(null);
  const [hideZero, setHideZero] = useState(false);

  const holders = useMemo(() => {
    const rows = [
      ...data.users.map((u) => ({ address: u.address, balance: u.balance, joined: u.createdAt as string | null, known: true })),
      ...data.unknownHolders.map((u) => ({ address: u.address, balance: u.balance, joined: null, known: false })),
    ];
    return (hideZero ? rows.filter((r) => BigInt(r.balance) !== 0n) : rows).sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
  }, [data, hideZero]);
  const userTotal = data.users.reduce((a, u) => a + BigInt(u.balance), 0n);
  const unknownTotal = BigInt(data.unknownTotal);
  const holdersStale = BigInt(data.holdersSyncedBlock) === 0n;

  async function act(fn: () => Promise<unknown>, done: (r: unknown) => string) {
    setBusy(true);
    try {
      setSweep(done(await fn()));
      await qc.invalidateQueries({ queryKey: ["admin-liabilities"] });
    } catch (e) {
      setSweep((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const reprocess = () =>
    act(
      () => api<{ processed: number; results: { kind: string; id: string; before: string; after: string }[] }>("/api/admin/reprocess", { method: "POST" }),
      (r) => {
        const x = r as { processed: number; results: { kind: string; id: string; before: string; after: string }[] };
        return x.processed === 0 ? "No stuck orders." : x.results.map((y) => `${y.kind} ${y.id.slice(0, 8)}: ${y.before} → ${y.after}`).join("\n");
      },
    );
  const reopen = (kind: "onramp" | "offramp", id: string) =>
    act(
      () => api(`/api/admin/orders/${kind}/${id}/reopen`, { method: "POST" }),
      () => `${kind} ${id.slice(0, 8)} reopened — it will be re-driven by the user's page or the next sweep`,
    );
  async function logout() {
    await api("/api/admin/login", { method: "DELETE" });
    router.push("/admin/login");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">ACME liabilities</h1>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            Live from Tempo testnet + the order ledger · refreshes every {REFRESH_MS / 1000}s
            {q.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
            {mounted && q.dataUpdatedAt > 0 && <span className="font-mono text-xs">updated {new Date(q.dataUpdatedAt).toLocaleTimeString()}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={reprocess} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Reprocess stuck orders</Button>
          <Button variant="ghost" onClick={logout}>Sign out</Button>
        </div>
      </div>
      {q.error && <p className="text-sm text-destructive">Refresh failed: {(q.error as Error).message} — showing the last good numbers.</p>}
      {sweep && <pre className="whitespace-pre-wrap rounded-lg border bg-muted p-3 text-xs">{sweep}</pre>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="AcmeUSD in circulation (user liabilities)" value={tok(data.chain.totalSupply)} sub="on-chain totalSupply" />
        <Stat label="USD reserves held (corporate)" value={usd(data.fiat.reservesHeld)} sub="Σ onramps minted − Σ offramps paid out" />
        <Stat label="Held by registered users" value={tok(userTotal.toString())} sub={`${data.users.length} wallets`} />
        <Stat label="Held by unknown addresses" value={tok(unknownTotal.toString())} sub={holdersStale ? "⚠ holder index unavailable — showing last known" : `${data.unknownHolders.length} addresses never registered here`} />
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
          <Recon label="Held outside registered users" value={data.reconciliation.heldByOutsiders} explain="Σ user balances + treasury + Fee AMM − totalSupply; should equal the unknown-address total below" />
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
                  <div key={s} className="flex items-center justify-between py-0.5"><StatusBadge status={s as never} /><span className="font-mono tabular-nums">{n}</span></div>
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
                <div className="flex justify-between"><span className="font-medium capitalize">{o.kind} · {tok(o.amount)}</span><span className="inline-flex items-center gap-1 font-mono text-xs"><Identicon address={o.userAddress} size={14} />{short(o.userAddress)}</span></div>
                <div className="text-xs text-muted-foreground">{o.lastError}</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-xs text-muted-foreground">{o.id}</div>
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => reopen(o.kind, o.id)}>Reopen (retry with fresh attempt)</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Holders (on-chain balances)</CardTitle>
              <CardDescription>Registered wallets plus every address that ever received AcmeUSD · indexed to block <span className="font-mono">{data.holdersSyncedBlock}</span></CardDescription>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} /> hide zero balances
            </label>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Wallet</TableHead><TableHead>Joined</TableHead><TableHead className="text-right">AcmeUSD</TableHead></TableRow></TableHeader>
            <TableBody>
              {holders.map((u) => (
                <TableRow key={u.address} className={u.known ? "" : "bg-amber-50/40"}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Identicon address={u.address} size={22} />
                      <a href={addressUrl(u.address)} target="_blank" rel="noreferrer" className="font-mono text-xs underline decoration-dotted">{u.address}</a>
                      {!u.known && (
                        <span
                          className="inline-flex cursor-help items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                          title="Unknown address: holds AcmeUSD but never created a passkey wallet here (P2P recipient or another app). Not a customer of this ledger."
                        >
                          <AlertTriangle className="h-3 w-3" /> unknown
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{u.joined && mounted ? new Date(u.joined).toLocaleString() : u.joined ? "…" : "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatAmount(BigInt(u.balance))}</TableCell>
                </TableRow>
              ))}
              {holders.length === 0 && <TableRow><TableCell colSpan={3} className="text-muted-foreground">{hideZero ? "No non-zero balances." : "No holders yet."}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
