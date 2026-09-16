"use client";

import { useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { isAddress, pad, stringToHex, type Hex } from "viem";
import { Hooks } from "wagmi/tempo";
import { AmountInput } from "@/components/amount-input";
import { Amount, TxLink } from "@/components/order-status";
import { RequireWallet } from "@/components/require-wallet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AmountError, FEE_BUFFER, formatAmount, parseAmount } from "@/lib/amounts";
import { ACME_USD, short } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

function Inner() {
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const transfer = Hooks.token.useTransferSync();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: Hex; amount: bigint; to: string } | null>(null);

  const max = balance.data !== undefined && balance.data > FEE_BUFFER ? balance.data - FEE_BUFFER : 0n;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    try {
      if (!isAddress(to)) throw new AmountError("Enter a valid Tempo address");
      if (to.toLowerCase() === address) throw new AmountError("That's your own address");
      const value = parseAmount(amount);
      if (balance.data !== undefined && value + FEE_BUFFER > balance.data) throw new AmountError(`Keep ${formatAmount(FEE_BUFFER)} for the fee — max ${formatAmount(max)}`);
      if (memo && new TextEncoder().encode(memo).length > 32) throw new AmountError("Memo must be 32 bytes or less");
      const res = await transfer.mutateAsync({
        token: ACME_USD,
        to: to as `0x${string}`,
        amount: value,
        memo: memo ? pad(stringToHex(memo), { size: 32 }) : undefined,
        feeToken: ACME_USD,
      });
      setSent({ hash: res.receipt.transactionHash, amount: value, to });
      setAmount("");
      setMemo("");
      void balance.refetch();
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Send AcmeUSD</CardTitle>
          <CardDescription>Settles in about a second on Tempo. The network fee is paid in AcmeUSD, so you never need another token.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="to">Recipient address</Label>
              <Input id="to" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} className="font-mono" autoComplete="off" />
            </div>
            <AmountInput value={amount} onChange={setAmount} max={formatAmount(max)} onMax={() => setAmount(formatAmount(max).replaceAll(",", ""))} hint={`Balance ${balance.data !== undefined ? formatAmount(balance.data) : "…"} · fee ≈ $0.001, reserved ${formatAmount(FEE_BUFFER)}`} />
            <div className="space-y-1.5">
              <Label htmlFor="memo">Memo (optional, on-chain, ≤ 32 bytes)</Label>
              <Input id="memo" placeholder="Invoice 42" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={transfer.isPending}>
              {transfer.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Confirm in your passkey…</> : <><Fingerprint className="h-4 w-4" /> Sign & send</>}
            </Button>
          </form>
        </CardContent>
      </Card>
      {sent && (
        <Alert>
          <AlertTitle>Sent <Amount value={sent.amount} /> to {short(sent.to)}</AlertTitle>
          <AlertDescription><TxLink hash={sent.hash} /></AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export default function SendPage() {
  return (
    <RequireWallet>
      <Inner />
    </RequireWallet>
  );
}
