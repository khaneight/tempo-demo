"use client";

import { useState } from "react";
import { Loader2, Fingerprint } from "lucide-react";
import { Hooks } from "wagmi/tempo";
import type { Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Amount } from "@/components/order-status";
import { formatAmount, FEE_BUFFER } from "@/lib/amounts";
import type { OfframpDto } from "@/lib/api-client";
import { ACME_USD, TREASURY, short } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

/**
 * The one on-chain step of an offramp, signed by the user's passkey.
 * The transfer carries the order's memo and pays its fee in AcmeUSD.
 * If the page dies after signing, "check status" recovers the transfer by memo.
 */
export function OfframpTransferStep({ order, onSubmitted, busy }: { order: OfframpDto; onSubmitted: (txHash: Hex) => void; busy: boolean }) {
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const transfer = Hooks.token.useTransferSync();
  const [error, setError] = useState<string | null>(null);
  const amount = BigInt(order.amount);
  const insufficient = balance.data !== undefined && balance.data < amount + FEE_BUFFER;

  async function send() {
    setError(null);
    try {
      const res = await transfer.mutateAsync({
        token: ACME_USD,
        to: TREASURY,
        amount,
        memo: order.memo as Hex,
        feeToken: ACME_USD,
      });
      onSubmitted(res.receipt.transactionHash);
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    }
  }

  return (
    <Alert>
      <AlertTitle>Step 1 · Send <Amount value={order.amount} /> to ACME</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          Transfer to treasury <span className="font-mono">{short(TREASURY)}</span> with memo <span className="font-mono">{short(order.memo)}</span>. The network fee is paid in AcmeUSD.
          {balance.data !== undefined && <> Balance: {formatAmount(balance.data)}.</>}
        </p>
        {insufficient && <p className="text-destructive">Not enough AcmeUSD to cover the amount plus fee.</p>}
        {error && <p className="text-destructive">{error}</p>}
        <Button onClick={send} disabled={transfer.isPending || busy || insufficient || !address}>
          {transfer.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          {transfer.isPending ? "Confirm in your passkey…" : "Sign & send with passkey"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
