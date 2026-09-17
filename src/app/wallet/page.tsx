"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { ActivityTable, type ActivityDto } from "@/components/activity-table";
import { DepositDialog } from "@/components/deposit-dialog";
import { Identicon } from "@/components/identicon";
import { RequireWallet } from "@/components/require-wallet";
import { SendDialog } from "@/components/send-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WalletSwitcher } from "@/components/wallet-switcher";
import { WithdrawDialog } from "@/components/withdraw-dialog";
import { formatAmount } from "@/lib/amounts";
import { api } from "@/lib/api-client";
import { addressUrl } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";
import { useWallets } from "@/lib/use-wallets";

type Flow = "deposit" | "withdraw" | "send" | "wallets" | null;

function Inner() {
  const { address } = useWallet();
  const { username, wallets } = useWallets();
  const current = wallets.find((w) => w.address === address);
  const balance = useAcmeBalance(address);
  const activity = useQuery({ queryKey: ["activity", address], queryFn: () => api<{ rows: ActivityDto[] }>("/api/activity"), refetchInterval: 10_000 });
  const [flow, setFlow] = useState<Flow>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Row 0: identity */}
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold">@{username ?? "…"}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{wallets.length} {wallets.length === 1 ? "wallet" : "wallets"}</span>
          </div>
          {/* Row 1: wallet selector (left) · balance (right) */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFlow("wallets")}
                className="group flex min-w-0 items-center gap-3 rounded-xl border bg-background py-2 pl-2 pr-4 text-left hover:bg-muted"
                title="Switch wallet"
              >
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                <Identicon address={address ?? ""} size={44} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{current?.label || "Wallet"}</span>
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{address}</div>
                </div>
              </button>
              <button
                type="button"
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Copy address"
                onClick={async () => {
                  await navigator.clipboard.writeText(address ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
              <a href={addressUrl(address ?? "")} target="_blank" rel="noreferrer" className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="View on explorer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
            <div className="sm:text-right">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Balance</div>
              <div className="flex items-baseline gap-2 sm:justify-end">
                <span className="font-mono text-4xl font-semibold tabular-nums">
                  {balance.data === undefined ? <Loader2 className="inline h-6 w-6 animate-spin" /> : formatAmount(balance.data)}
                </span>
                <span className="text-sm text-muted-foreground">AcmeUSD</span>
              </div>
            </div>
          </div>
          {/* Row 2: actions */}
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button onClick={() => setFlow("deposit")}>Deposit</Button>
            <Button variant="outline" onClick={() => setFlow("withdraw")} disabled={!balance.data}>Withdraw</Button>
            <Button variant="outline" onClick={() => setFlow("send")} disabled={!balance.data}>Send</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityTable rows={activity.data?.rows ?? []} loading={activity.isLoading} />
          {activity.error && <p className="mt-2 text-xs text-destructive">{(activity.error as Error).message}</p>}
        </CardContent>
      </Card>

      <DepositDialog open={flow === "deposit"} onOpenChange={(o) => setFlow(o ? "deposit" : null)} />
      <WithdrawDialog open={flow === "withdraw"} onOpenChange={(o) => setFlow(o ? "withdraw" : null)} />
      <SendDialog open={flow === "send"} onOpenChange={(o) => setFlow(o ? "send" : null)} />
      <WalletSwitcher open={flow === "wallets"} onOpenChange={(o) => setFlow(o ? "wallets" : null)} />
    </div>
  );
}

export default function WalletPage() {
  return (
    <RequireWallet>
      <Inner />
    </RequireWallet>
  );
}
