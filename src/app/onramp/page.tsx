"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AmountInput } from "@/components/amount-input";
import { RequireWallet } from "@/components/require-wallet";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type OnrampDto } from "@/lib/api-client";

export default function OnrampPage() {
  const router = useRouter();
  const [amount, setAmount] = useState("25");
  const [card, setCard] = useState({ name: "", number: "4242 4242 4242 4242", exp: "12/30", cvc: "123" });
  // One key per form session: a double-click or a retried request can never create two orders.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: OnrampDto }>("/api/onramp", { method: "POST", json: { amount, idempotencyKey, card } });
      router.push(`/orders/onramp/${r.order.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <RequireWallet>
      <div className="mx-auto max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Buy AcmeUSD</CardTitle>
            <CardDescription>Pay with (test) USD and receive AcmeUSD in your wallet on Tempo. 1 AcmeUSD = 1 USD.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <AmountInput value={amount} onChange={setAmount} label="Amount (USD)" hint="Between 1.00 and 10,000.00" />
              <div className="grid gap-3 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Test card — any Luhn-valid number works, nothing is charged.</p>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name on card</Label>
                  <Input id="name" required value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} autoComplete="cc-name" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="number">Card number</Label>
                  <Input id="number" required inputMode="numeric" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} autoComplete="cc-number" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="exp">Expiry</Label>
                    <Input id="exp" required placeholder="MM/YY" value={card.exp} onChange={(e) => setCard({ ...card, exp: e.target.value })} autoComplete="cc-exp" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cvc">CVC</Label>
                    <Input id="cvc" required inputMode="numeric" value={card.cvc} onChange={(e) => setCard({ ...card, cvc: e.target.value })} autoComplete="cc-csc" />
                  </div>
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : `Pay $${amount || "0"} and receive AcmeUSD`}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </RequireWallet>
  );
}
