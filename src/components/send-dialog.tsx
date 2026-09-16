"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { isAddress, pad, stringToHex, type Hex } from "viem";
import { Hooks } from "wagmi/tempo";
import { AmountInput } from "@/components/amount-input";
import { Identicon } from "@/components/identicon";
import { Amount, TxLink } from "@/components/order-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AmountError, FEE_BUFFER, formatAmount, parseAmount } from "@/lib/amounts";
import { ACME_USD, short } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

/** Transfer AcmeUSD to any Tempo address, fee paid in AcmeUSD, signed by the passkey. */
export function SendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
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
    try {
      if (!isAddress(to)) throw new AmountError("Enter a valid Tempo address");
      if (to.toLowerCase() === address) throw new AmountError("That's your own address");
      const value = parseAmount(amount);
      if (balance.data !== undefined && value + FEE_BUFFER > balance.data) throw new AmountError(`Keep ${formatAmount(FEE_BUFFER)} for the fee — max ${formatAmount(max)}`);
      if (memo && new TextEncoder().encode(memo).length > 32) throw new AmountError("Memo must be 32 bytes or less");
      const res = await transfer.mutateAsync({ token: ACME_USD, to: to as `0x${string}`, amount: value, memo: memo ? pad(stringToHex(memo), { size: 32 }) : undefined, feeToken: ACME_USD });
      setSent({ hash: res.receipt.transactionHash, amount: value, to });
      void balance.refetch();
      void qc.invalidateQueries({ queryKey: ["activity"] });
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
    }
  }

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setSent(null);
      setError(null);
      setAmount("");
      setMemo("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send</DialogTitle>
          <DialogDescription>Settles in about a second on Tempo. The network fee is paid in AcmeUSD.</DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="space-y-4">
            <Alert>
              <AlertTitle className="flex items-center gap-2">Sent <Amount value={sent.amount} /> to <Identicon address={sent.to} size={18} /> <span className="font-mono">{short(sent.to)}</span></AlertTitle>
              <AlertDescription><TxLink hash={sent.hash} /></AlertDescription>
            </Alert>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSent(null)}>Send another</Button>
              <Button onClick={() => close(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="send-to">Recipient address</Label>
              <div className="flex items-center gap-2">
                {isAddress(to) && <Identicon address={to} size={28} />}
                <Input id="send-to" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} className="font-mono" autoComplete="off" />
              </div>
            </div>
            <AmountInput value={amount} onChange={setAmount} max={formatAmount(max)} onMax={() => setAmount(formatAmount(max).replaceAll(",", ""))} hint={`Balance ${balance.data !== undefined ? formatAmount(balance.data) : "…"} · fee ≈ $0.001, ${formatAmount(FEE_BUFFER)} reserved`} />
            <div className="space-y-1.5">
              <Label htmlFor="send-memo">Memo (optional, on-chain, ≤ 32 bytes)</Label>
              <Input id="send-memo" placeholder="Invoice 42" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={transfer.isPending}>
              {transfer.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Confirm in your passkey…</> : <><Fingerprint className="h-4 w-4" /> Sign & send</>}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
