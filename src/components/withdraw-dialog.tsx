"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Hex } from "viem";
import { AmountInput } from "@/components/amount-input";
import { OfframpTransferStep } from "@/components/offramp-transfer-step";
import { Amount, OFFRAMP_STEPS, Timeline, TxLink } from "@/components/order-status";
import { ResultScreen } from "@/components/result-screen";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FEE_BUFFER, formatAmount } from "@/lib/amounts";
import { api, type OfframpDto } from "@/lib/api-client";
import { useOrder } from "@/lib/use-order";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

/**
 * Withdraw (cash out) in one popup: 1) amount + bank → order, 2) sign the transfer
 * with the passkey, 3) the server verifies / pays out / burns while this popup polls
 * the order and shows the outcome.
 */
export function WithdrawDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState({ accountName: "", routing: "021000021", account: "000123456789" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = useOrder("offramp", null);
  const max = balance.data !== undefined && balance.data > FEE_BUFFER ? balance.data - FEE_BUFFER : 0n;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: OfframpDto }>("/api/offramp", { method: "POST", json: { amount, bank } });
      o.setOrder(r.order);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function close(v: boolean) {
    onOpenChange(v);
    if (!v) {
      o.setOrder(null);
      setAmount("");
      setError(null);
    }
  }

  const order = o.order;
  const awaiting = !!order && (order.status === "created" || order.status === "expired");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>
            {order ? <>Cashing out <Amount value={order.amount} /> to your bank.</> : "Send AcmeUSD back to ACME and receive (test) USD. You'll sign one transfer with your passkey."}
          </DialogDescription>
        </DialogHeader>

        {!order && (
          <form onSubmit={create} className="space-y-4">
            <AmountInput value={amount} onChange={setAmount} label="Amount (AcmeUSD)" max={formatAmount(max)} onMax={() => setAmount(formatAmount(max).replaceAll(",", ""))} hint={`Balance ${balance.data !== undefined ? formatAmount(balance.data) : "…"} · ${formatAmount(FEE_BUFFER)} reserved for the fee`} />
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Test bank account — nothing is actually transferred.</p>
              <div className="space-y-1.5">
                <Label htmlFor="wd-an">Account holder</Label>
                <Input id="wd-an" required value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wd-rt">Routing number</Label>
                  <Input id="wd-rt" required inputMode="numeric" className="font-mono" value={bank.routing} onChange={(e) => setBank({ ...bank, routing: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wd-ac">Account number</Label>
                  <Input id="wd-ac" required inputMode="numeric" className="font-mono" value={bank.account} onChange={(e) => setBank({ ...bank, account: e.target.value })} />
                </div>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Continue
            </Button>
          </form>
        )}

        {order && (
          <div className="space-y-4">
            <Timeline steps={OFFRAMP_STEPS} status={order.status} kind="offramp" />
            {awaiting && <OfframpTransferStep order={order} onSubmitted={(txHash: Hex) => o.retry.mutate({ txHash })} busy={o.busy} />}
            {!awaiting && o.pending && (
              <ResultScreen kind="pending" title={order.status === "transfer_verified" ? "Transfer verified — paying out…" : order.status === "credited" || order.status === "burning" ? "USD sent — retiring tokens…" : "Verifying your transfer…"} actions={<Button variant="ghost" onClick={() => close(false)}>Close — I&apos;ll check back</Button>}>
                {o.message ?? "You can close this; the order keeps going and shows up in Activity."}
              </ResultScreen>
            )}
            {o.state === "done" && (
              <ResultScreen kind="success" title={<>Sent <Amount value={order.amount} /> to your bank</>} actions={<Button onClick={() => close(false)}>Done</Button>}>
                <div className="flex flex-col items-center gap-1">
                  <TxLink hash={order.transferTxHash} label="Your transfer" />
                  <TxLink hash={order.burnTxHash} label="Burn transaction" />
                </div>
              </ResultScreen>
            )}
            {o.state === "review" && (
              <ResultScreen kind="attention" title="Needs a human look" actions={<Button variant="outline" onClick={() => close(false)}>Close</Button>}>
                {order.creditedAt ? "Your USD has been sent; ACME will finish the bookkeeping." : "Your tokens are safe with ACME; support will finish this manually."} {order.lastError}
              </ResultScreen>
            )}
            {o.message && awaiting && <p className="text-center text-sm text-muted-foreground">{o.message}</p>}
            <p className="text-center text-xs text-muted-foreground">
              <Link href={`/orders/offramp/${order.id}`} className="underline decoration-dotted">Order {order.id.slice(0, 8)}</Link>
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
