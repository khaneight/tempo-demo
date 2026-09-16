"use client";

import { CheckCircle2, CircleDashed, Loader2, AlertTriangle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/amounts";
import { txUrl } from "@/lib/client-config";
import type { OfframpDto, OnrampDto } from "@/lib/api-client";

export const ONRAMP_STEPS: { key: OnrampDto["status"][]; label: string }[] = [
  { key: ["created"], label: "Order placed" },
  { key: ["payment_captured"], label: "USD received" },
  { key: ["minting"], label: "Minting AcmeUSD" },
  { key: ["minted"], label: "Delivered to your wallet" },
];

export const OFFRAMP_STEPS: { key: OfframpDto["status"][]; label: string }[] = [
  { key: ["created", "expired"], label: "Send AcmeUSD to ACME" },
  { key: ["transfer_verified"], label: "Transfer verified on-chain" },
  { key: ["credited"], label: "USD sent to your bank" },
  { key: ["burning", "burned"], label: "Tokens retired" },
];

export type UiState = "pending" | "in_progress" | "done" | "failed" | "review" | "action";

export function uiState(status: OnrampDto["status"] | OfframpDto["status"]): UiState {
  switch (status) {
    case "minted":
    case "burned":
      return "done";
    case "failed":
      return "failed";
    case "needs_review":
      return "review";
    case "minting":
    case "burning":
      return "in_progress";
    case "created":
    case "expired":
      return "action";
    default:
      return "pending";
  }
}

export function StatusBadge({ status }: { status: OnrampDto["status"] | OfframpDto["status"] }) {
  const s = uiState(status);
  const variant = s === "done" ? "default" : s === "failed" || s === "review" ? "destructive" : "secondary";
  const label = status.replaceAll("_", " ");
  return (
    <Badge variant={variant} className="capitalize">
      {s === "in_progress" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {label}
    </Badge>
  );
}

export function Timeline({ steps, status, kind }: { steps: { key: string[]; label: string }[]; status: string; kind: "onramp" | "offramp" }) {
  const idx = steps.findIndex((st) => st.key.includes(status));
  const terminalDone = status === "minted" || status === "burned";
  const failed = status === "failed" || status === "needs_review";
  return (
    <ol className="space-y-2">
      {steps.map((st, i) => {
        const done = terminalDone || i < idx;
        const current = i === idx && !terminalDone;
        const Icon = done ? CheckCircle2 : current ? (failed ? AlertTriangle : Loader2) : CircleDashed;
        const cls = done ? "text-emerald-600" : current ? (failed ? "text-amber-600" : "text-blue-600") : "text-muted-foreground";
        return (
          <li key={st.label} className={`flex items-center gap-2 text-sm ${cls}`}>
            <Icon className={`h-4 w-4 ${current && !failed ? "animate-spin" : ""}`} />
            <span className={done || current ? "font-medium" : ""}>{st.label}</span>
            {kind === "onramp" && i === 3 && status === "failed" && <XCircle className="h-4 w-4 text-red-600" />}
          </li>
        );
      })}
    </ol>
  );
}

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (!hash) return null;
  return (
    <a className="text-xs underline decoration-dotted underline-offset-2 text-muted-foreground hover:text-foreground" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {label ?? "View on explorer"} ↗
    </a>
  );
}

export function Amount({ value, className = "" }: { value: string | bigint; className?: string }) {
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {formatAmount(BigInt(value))} <span className="font-sans text-muted-foreground">AcmeUSD</span>
    </span>
  );
}
