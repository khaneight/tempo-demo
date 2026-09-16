"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { Hooks } from "wagmi/tempo";
import { OrderList } from "@/components/order-card";
import { RequireWallet } from "@/components/require-wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount } from "@/lib/amounts";
import { api, type OfframpDto, type OnrampDto } from "@/lib/api-client";
import { ACME_USD, addressUrl } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

function Inner() {
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => api<{ onramps: OnrampDto[]; offramps: OfframpDto[] }>("/api/orders"), refetchInterval: 8_000 });
  const feeToken = Hooks.fee.useUserToken({ account: address, query: { enabled: !!address } });
  const setFeeToken = Hooks.fee.useSetUserTokenSync();
  const [copied, setCopied] = useState(false);
  const feeIsAcme = feeToken.data?.address?.toLowerCase() === ACME_USD;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardDescription>Your balance</CardDescription>
            <CardTitle className="text-4xl tabular-nums">
              {balance.data === undefined ? <Loader2 className="h-6 w-6 animate-spin" /> : formatAmount(balance.data)} <span className="text-base font-normal text-muted-foreground">AcmeUSD</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button nativeButton={false} render={<Link href="/onramp" />}>Buy</Button>
            <Button nativeButton={false} variant="outline" render={<Link href="/offramp" />}>Cash out</Button>
            <Button nativeButton={false} variant="outline" render={<Link href="/send" />}>Send</Button>
          </CardContent>
        </Card>

        {orders.data && (
          <div className="grid gap-4 md:grid-cols-2">
            <OrderList title="Purchases" kind="onramp" orders={orders.data.onramps} />
            <OrderList title="Cash-outs" kind="offramp" orders={orders.data.offramps} />
          </div>
        )}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Receive</CardTitle>
            <CardDescription>Your Tempo address. Anyone can send you AcmeUSD here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <code className="block break-all rounded bg-muted p-2 text-xs">{address}</code>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(address ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
              </Button>
              <Button nativeButton={false} size="sm" variant="ghost" render={<a href={addressUrl(address ?? "")} target="_blank" rel="noreferrer" />}>Explorer ↗</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Network fees</CardTitle>
            <CardDescription>Tempo has no gas token — fees are paid in stablecoins. Every AcmeUSD transaction from this app already pays its fee in AcmeUSD; setting it as your default covers other apps too.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Default fee token: {feeToken.isLoading ? "…" : feeIsAcme ? <span className="font-medium text-emerald-700">AcmeUSD ✓</span> : <span className="text-muted-foreground">not set (pathUSD fallback)</span>}</p>
            {!feeIsAcme && (
              <Button
                size="sm"
                variant="outline"
                disabled={setFeeToken.isPending || !balance.data}
                onClick={() => setFeeToken.mutate({ token: ACME_USD, feeToken: ACME_USD }, { onSuccess: () => feeToken.refetch() })}
              >
                {setFeeToken.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Pay all fees in AcmeUSD
              </Button>
            )}
            {setFeeToken.error && <p className="text-xs text-destructive">{setFeeToken.error.message.split("\n")[0]}</p>}
            {!balance.data && <p className="text-xs text-muted-foreground">Buy some AcmeUSD first — the fee for this transaction is paid in AcmeUSD.</p>}
          </CardContent>
        </Card>
      </div>
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
