"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { ActivityTable, type ActivityDto } from "@/components/activity-table";
import { DepositDialog } from "@/components/deposit-dialog";
import { Identicon } from "@/components/identicon";
import { RequireWallet } from "@/components/require-wallet";
import { SendDialog } from "@/components/send-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WithdrawDialog } from "@/components/withdraw-dialog";
import { formatAmount } from "@/lib/amounts";
import { api } from "@/lib/api-client";
import { addressUrl } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

type Flow = "deposit" | "withdraw" | "send" | null;

function Inner() {
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => api<{ rows: ActivityDto[] }>("/api/activity"), refetchInterval: 10_000 });
  const [flow, setFlow] = useState<Flow>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Identicon address={address ?? ""} size={56} />
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Passkey wallet · Tempo testnet</div>
              <div className="mt-1 flex items-center gap-2">
                <code className="truncate font-mono text-sm">{address}</code>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Copy address"
                  onClick={async () => {
                    await navigator.clipboard.writeText(address ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
                <a href={addressUrl(address ?? "")} target="_blank" rel="noreferrer" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="View on explorer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-4xl font-semibold tabular-nums">
                  {balance.data === undefined ? <Loader2 className="inline h-6 w-6 animate-spin" /> : formatAmount(balance.data)}
                </span>
                <span className="text-sm text-muted-foreground">AcmeUSD</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
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
