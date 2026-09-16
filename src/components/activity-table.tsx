"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Banknote, Landmark, Receipt } from "lucide-react";
import { Identicon } from "@/components/identicon";
import { StatusBadge, TxLink, uiState } from "@/components/order-status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAmount } from "@/lib/amounts";
import type { ActivityKind } from "@/lib/activity";
import { addressUrl, short } from "@/lib/client-config";

export type ActivityDto = {
  id: string;
  kind: ActivityKind;
  amount: string;
  status: string;
  counterparty: string | null;
  memo: string | null;
  txHash: string | null;
  orderId: string | null;
  at: string;
};

type KindFilter = "all" | ActivityKind;
type StatusFilter = "all" | "pending" | "done" | "attention";
type Sort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

const KIND: Record<ActivityKind, { label: string; sign: "+" | "−"; Icon: typeof ArrowUpRight; color: string }> = {
  deposit: { label: "Deposit", sign: "+", Icon: Banknote, color: "text-emerald-700" },
  withdrawal: { label: "Withdrawal", sign: "−", Icon: Landmark, color: "text-foreground" },
  send: { label: "Sent", sign: "−", Icon: ArrowUpRight, color: "text-foreground" },
  receive: { label: "Received", sign: "+", Icon: ArrowDownLeft, color: "text-emerald-700" },
  fee: { label: "Network fee", sign: "−", Icon: Receipt, color: "text-muted-foreground" },
};

function statusBucket(r: ActivityDto): StatusFilter {
  if (r.kind === "send" || r.kind === "receive" || r.kind === "fee") return "done";
  const s = uiState(r.status as never);
  if (s === "done") return "done";
  if (s === "failed" || s === "review") return "attention";
  return "pending";
}

function Counterparty({ r }: { r: ActivityDto }) {
  if (r.kind === "deposit") return <span className="text-muted-foreground">ACME (card)</span>;
  if (r.kind === "withdrawal") return <span className="text-muted-foreground">ACME (bank)</span>;
  if (r.kind === "fee") return <span className="text-muted-foreground">Tempo fee</span>;
  if (r.counterparty === "mint") return <span className="text-muted-foreground">ACME (mint)</span>;
  if (r.counterparty === "burn") return <span className="text-muted-foreground">burn</span>;
  if (!r.counterparty) return null;
  return (
    <a href={addressUrl(r.counterparty)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:underline">
      <Identicon address={r.counterparty} size={18} />
      <span className="font-mono text-xs">{short(r.counterparty)}</span>
    </a>
  );
}

const selectCls = "h-8 rounded-md border bg-background px-2 text-xs";

export function ActivityTable({ rows, loading }: { rows: ActivityDto[]; loading?: boolean }) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("date_desc");
  const [hideFees, setHideFees] = useState(true);

  const visible = useMemo(() => {
    let out = rows.filter((r) => (kind === "all" ? !(hideFees && r.kind === "fee") : r.kind === kind));
    if (status !== "all") out = out.filter((r) => statusBucket(r) === status);
    const by: Record<Sort, (a: ActivityDto, b: ActivityDto) => number> = {
      date_desc: (a, b) => b.at.localeCompare(a.at),
      date_asc: (a, b) => a.at.localeCompare(b.at),
      amount_desc: (a, b) => Number(BigInt(b.amount) - BigInt(a.amount)),
      amount_asc: (a, b) => Number(BigInt(a.amount) - BigInt(b.amount)),
    };
    return [...out].sort(by[sort]);
  }, [rows, kind, status, sort, hideFees]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="Type">
          <option value="all">All types</option>
          <option value="deposit">Deposits</option>
          <option value="withdrawal">Withdrawals</option>
          <option value="send">Sent</option>
          <option value="receive">Received</option>
          <option value="fee">Network fees</option>
        </select>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="all">Any status</option>
          <option value="pending">In progress</option>
          <option value="done">Completed</option>
          <option value="attention">Needs attention</option>
        </select>
        <select className={selectCls} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="amount_desc">Largest amount</option>
          <option value="amount_asc">Smallest amount</option>
        </select>
        {kind === "all" && (
          <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={hideFees} onChange={(e) => setHideFees(e.target.checked)} /> hide network fees
          </label>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>With</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Links</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">{loading ? "Loading…" : rows.length ? "Nothing matches these filters." : "No activity yet — make your first deposit."}</TableCell>
              </TableRow>
            )}
            {visible.map((r) => {
              const k = KIND[r.kind];
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2"><k.Icon className="h-4 w-4 text-muted-foreground" /> {k.label}</span>
                    {r.memo && r.memo !== "0x" && <div className="font-mono text-[10px] text-muted-foreground">memo {short(r.memo)}</div>}
                  </TableCell>
                  <TableCell><Counterparty r={r} /></TableCell>
                  <TableCell className={`text-right font-mono tabular-nums ${k.color}`}>{k.sign}{formatAmount(BigInt(r.amount))}</TableCell>
                  <TableCell>{r.kind === "deposit" || r.kind === "withdrawal" ? <StatusBadge status={r.status as never} /> : <span className="text-xs text-muted-foreground">confirmed</span>}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{new Date(r.at).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-3">
                      {r.orderId && <Link href={`/orders/${r.kind === "deposit" ? "onramp" : "offramp"}/${r.orderId}`} className="text-xs underline decoration-dotted">order</Link>}
                      <TxLink hash={r.txHash} label="tx" />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
