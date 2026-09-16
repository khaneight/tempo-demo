"use client";

import { useState } from "react";
import { Check, Fingerprint, Loader2, Pencil, Plus } from "lucide-react";
import { useReadContracts } from "wagmi";
import { Abis } from "viem/tempo";
import { Identicon } from "@/components/identicon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/amounts";
import { ACME_USD, short } from "@/lib/client-config";
import { renameWallet, useWallets } from "@/lib/use-wallets";

/** Switch between this device's passkey wallets (click a row), rename them, or register a new one. */
export function WalletSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { wallets, active, switchTo, create, busy } = useWallets();
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const balances = useReadContracts({
    contracts: wallets.map((w) => ({ address: ACME_USD, abi: Abis.tip20, functionName: "balanceOf" as const, args: [w.address] as const })),
    query: { enabled: open && wallets.length > 0, refetchInterval: 10_000 },
  });

  async function run(fn: () => Promise<void>, closeAfter = true) {
    setError(null);
    try {
      await fn();
      if (closeAfter) onOpenChange(false);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setError(/not allowed|cancel|abort|focus/i.test(m) ? "Passkey prompt was cancelled — try again." : m.split("\n")[0]);
    }
  }

  function saveName(address: string) {
    renameWallet(address, draft || "Wallet");
    setEditing(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your wallets</DialogTitle>
          <DialogDescription>Each wallet is its own passkey on this device. Click one to switch — you only sign in once per wallet.</DialogDescription>
        </DialogHeader>
        <ul className="divide-y rounded-lg border">
          {wallets.length === 0 && <li className="p-3 text-sm text-muted-foreground">No wallets remembered on this device yet.</li>}
          {wallets.map((w, i) => {
            const isActive = w.address === active;
            const bal = balances.data?.[i]?.result as bigint | undefined;
            const isEditing = editing === w.address;
            return (
              <li
                key={w.address}
                role="button"
                tabIndex={0}
                aria-current={isActive}
                onClick={() => !isEditing && !isActive && run(() => switchTo(w))}
                onKeyDown={(e) => e.key === "Enter" && !isEditing && !isActive && run(() => switchTo(w))}
                className={`flex cursor-pointer items-center gap-3 p-3 outline-none transition-colors ${isActive ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : "hover:bg-muted/60 focus-visible:bg-muted/60"}`}
              >
                <Identicon address={w.address} size={36} />
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <form
                      className="flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveName(w.address);
                      }}
                    >
                      <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} className="h-7 text-sm" onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
                      <Button type="submit" size="xs">Save</Button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{w.label || "Wallet"}</span>
                      <button
                        type="button"
                        title="Rename"
                        className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraft(w.label);
                          setEditing(w.address);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  <div className="font-mono text-xs text-muted-foreground">{short(w.address)}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm tabular-nums">{bal === undefined ? "…" : formatAmount(bal)}</div>
                  <div className="text-[10px] text-muted-foreground">{isActive ? <span className="inline-flex items-center gap-0.5 text-emerald-700"><Check className="h-3 w-3" /> active</span> : "AcmeUSD"}</div>
                </div>
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
        {busy && !adding && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Confirm with your passkey…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
