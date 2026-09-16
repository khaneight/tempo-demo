"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Hex } from "viem";
import { AmountInput } from "@/components/amount-input";
import { OfframpTransferStep } from "@/components/offramp-transfer-step";
import { OFFRAMP_STEPS, StatusBadge, Timeline, TxLink } from "@/components/order-status";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FEE_BUFFER, formatAmount } from "@/lib/amounts";
import { api, type OfframpDto } from "@/lib/api-client";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

/**
 * Withdraw (cash out) in one popup: 1) amount + bank → order, 2) sign the transfer
 * with the passkey, 3) server verifies/pays/burns and the result is shown inline.
 */
export function WithdrawDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState({ accountName: "", routing: "021000021", account: "000123456789" });
  const [order, setOrder] = useState<OfframpDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const max = balance.data !== undefined && balance.data > FEE_BUFFER ? balance.data - FEE_BUFFER : 0n;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: OfframpDto }>("/api/offramp", { method: "POST", json: { amount, bank } });
      setOrder(r.order);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitted(txHash: Hex) {
    if (!order) return;
    setBusy(true);
    try {
      const r = await api<{ order: OfframpDto; message?: string }>(`/api/offramp/${order.id}/process`, { method: "POST", json: { txHash } });
      setOrder(r.order);
      setMessage(r.message ?? null);
      void qc.invalidateQueries({ queryKey: ["activity"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) {
      setOrder(null);
      setAmount("");
      setError(null);
      setMessage(null);
    }
  }

  const awaiting = order && (order.status === "created" || order.status === "expired");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw</DialogTitle>
          <DialogDescription>
            {order ? <>Cash out <span className="font-mono">{formatAmount(BigInt(order.amount))}</span> AcmeUSD to your bank.</> : "Send AcmeUSD back to ACME and receive (test) USD. You'll sign one transfer with your passkey."}
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
            <div className="flex items-center justify-between">
              <Timeline steps={OFFRAMP_STEPS} status={order.status} kind="offramp" />
              <StatusBadge status={order.status} />
            </div>
            {awaiting && <OfframpTransferStep order={order} onSubmitted={submitted} busy={busy} />}
            {busy && !awaiting && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Verifying and paying out…</p>}
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {(order.transferTxHash || order.burnTxHash) && (
              <div className="flex flex-col gap-1">
                <TxLink hash={order.transferTxHash} label="Your transfer" />
                <TxLink hash={order.burnTxHash} label="Burn transaction" />
              </div>
            )}
            <div className="flex items-center justify-between">
              <Link href={`/orders/offramp/${order.id}`} className="text-xs text-muted-foreground underline decoration-dotted">Open order page</Link>
              <Button variant="outline" onClick={() => close(false)}>{order.status === "burned" ? "Done" : "Close — I'll check back later"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
