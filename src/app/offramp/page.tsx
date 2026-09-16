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
import { FEE_BUFFER, formatAmount } from "@/lib/amounts";
import { api, type OfframpDto } from "@/lib/api-client";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";

function Inner() {
  const router = useRouter();
  const { address } = useWallet();
  const balance = useAcmeBalance(address);
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState({ accountName: "", routing: "021000021", account: "000123456789" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = balance.data !== undefined && balance.data > FEE_BUFFER ? balance.data - FEE_BUFFER : 0n;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ order: OfframpDto }>("/api/offramp", { method: "POST", json: { amount, bank } });
      router.push(`/orders/offramp/${r.order.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Cash out to USD</CardTitle>
          <CardDescription>Send AcmeUSD back to ACME and receive (test) USD in your bank account. Two steps: place the order, then sign one transfer with your passkey.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <AmountInput value={amount} onChange={setAmount} label="Amount (AcmeUSD)" max={formatAmount(max)} onMax={() => setAmount(formatAmount(max).replaceAll(",", ""))} hint={`Balance ${balance.data !== undefined ? formatAmount(balance.data) : "…"} · ${formatAmount(FEE_BUFFER)} reserved for the fee`} />
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Test bank account — nothing is actually transferred.</p>
              <div className="space-y-1.5">
                <Label htmlFor="an">Account holder</Label>
                <Input id="an" required value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rt">Routing number</Label>
                  <Input id="rt" required inputMode="numeric" value={bank.routing} onChange={(e) => setBank({ ...bank, routing: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ac">Account number</Label>
                  <Input id="ac" required inputMode="numeric" value={bank.account} onChange={(e) => setBank({ ...bank, account: e.target.value })} />
                </div>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Continue
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OfframpPage() {
  return (
    <RequireWallet>
      <Inner />
    </RequireWallet>
  );
}
