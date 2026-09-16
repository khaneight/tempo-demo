"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AmountInput } from "@/components/amount-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type OnrampDto } from "@/lib/api-client";

/** Deposit (buy): fake card → AcmeUSD minted to the wallet. Navigates to the order page on submit. */
export function DepositDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [amount, setAmount] = useState("25");
  const [card, setCard] = useState({ name: "", number: "4242 4242 4242 4242", exp: "12/30", cvc: "123" });
  // One key per dialog session: a double-click or retried request can never create two orders.
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: OnrampDto }>("/api/onramp", { method: "POST", json: { amount, idempotencyKey, card } });
      setKey(crypto.randomUUID());
      onOpenChange(false);
      router.push(`/orders/onramp/${r.order.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deposit</DialogTitle>
          <DialogDescription>Pay with (test) USD and receive AcmeUSD in your wallet. 1 AcmeUSD = 1 USD.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <AmountInput value={amount} onChange={setAmount} label="Amount (USD)" hint="Between 1.00 and 10,000.00" />
          <div className="grid gap-3 rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Test card — any Luhn-valid number works, nothing is charged.</p>
            <div className="space-y-1.5">
              <Label htmlFor="dep-name">Name on card</Label>
              <Input id="dep-name" required value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} autoComplete="cc-name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-number">Card number</Label>
              <Input id="dep-number" required inputMode="numeric" className="font-mono" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} autoComplete="cc-number" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dep-exp">Expiry</Label>
                <Input id="dep-exp" required placeholder="MM/YY" className="font-mono" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} autoComplete="cc-exp" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dep-cvc">CVC</Label>
                <Input id="dep-cvc" required inputMode="numeric" className="font-mono" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} autoComplete="cc-csc" />
              </div>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : <>Pay <span className="font-mono">${amount || "0"}</span> and receive AcmeUSD</>}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
