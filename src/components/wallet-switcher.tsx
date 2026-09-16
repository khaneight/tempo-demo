"use client";

import { useState } from "react";
import { Check, Fingerprint, Loader2, Plus, Trash2 } from "lucide-react";
import { useReadContracts } from "wagmi";
import { Abis } from "viem/tempo";
import { Identicon } from "@/components/identicon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/amounts";
import { ACME_USD, short } from "@/lib/client-config";
import { forgetWallet, useWallets } from "@/lib/use-wallets";

/** Switch between this device's passkey wallets, or register a new named one. */
export function WalletSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { wallets, active, switchTo, create, busy } = useWallets();
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const balances = useReadContracts({
    contracts: wallets.map((w) => ({ address: ACME_USD, abi: Abis.tip20, functionName: "balanceOf" as const, args: [w.address] as const })),
    query: { enabled: open && wallets.length > 0, refetchInterval: 10_000 },
  });

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
      onOpenChange(false);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setError(/not allowed|cancel|abort|focus/i.test(m) ? "Passkey prompt was cancelled — try again." : m.split("\n")[0]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your wallets</DialogTitle>
          <DialogDescription>Each wallet is its own passkey on this device. Switching asks for one passkey confirmation.</DialogDescription>
        </DialogHeader>
        <ul className="divide-y rounded-lg border">
          {wallets.length === 0 && <li className="p-3 text-sm text-muted-foreground">No wallets remembered on this device yet.</li>}
          {wallets.map((w, i) => {
            const isActive = w.address === active;
            const bal = balances.data?.[i]?.result as bigint | undefined;
            return (
              <li key={w.address} className={`flex items-center gap-3 p-3 ${isActive ? "bg-muted/50" : ""}`}>
                <Identicon address={w.address} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{w.label || "Wallet"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{short(w.address)} · {bal === undefined ? "…" : formatAmount(bal)} AcmeUSD</div>
                </div>
                {isActive ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" /> active</span>
                ) : (
                  <>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => switchTo(w))}>
                      <Fingerprint className="h-3.5 w-3.5" /> Switch
                    </Button>
                    <button type="button" className="rounded p-1 text-muted-foreground hover:text-destructive" title="Forget on this device (the passkey itself is not deleted)" onClick={() => forgetWallet(w.address)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {adding ? (
          <form
            className="space-y-2 rounded-lg border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => create(label.trim() || `Wallet ${wallets.length + 1}`)).then(() => {
                setAdding(false);
                setLabel("");
              });
            }}
          >
            <Label htmlFor="wallet-label">Name this wallet</Label>
            <div className="flex gap-2">
              <Input id="wallet-label" autoFocus placeholder="e.g. Savings" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
              <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} Create</Button>
            </div>
            <p className="text-xs text-muted-foreground">Creates a new passkey (a new address) and switches to it.</p>
          </form>
        ) : (
          <Button variant="outline" onClick={() => setAdding(true)} disabled={busy}><Plus className="h-4 w-4" /> Add a wallet</Button>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
