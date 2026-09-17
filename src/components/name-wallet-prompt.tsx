"use client";

import { useState } from "react";
import { Identicon } from "@/components/identicon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { short } from "@/lib/client-config";
import { renameWallet, useWallets } from "@/lib/use-wallets";

const SKIP_KEY = "acmeusd.skipNaming";

/**
 * First time a wallet is used on this device without a person-chosen name (signed
 * in with an existing passkey, or created before naming existed), ask for one —
 * prefilled with the SDK's registration label if there is one. Skippable; the
 * wallet switcher's rename button is always there later.
 */
export function NameWalletPrompt() {
  const { wallets, active } = useWallets();
  const [draft, setDraft] = useState("");
  const [skipped, setSkipped] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(SKIP_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const current = active ? wallets.find((w) => w.address === active) : undefined;
  const open = !!current && !current.named && !skipped.includes(current.address);

  function skip() {
    if (!current) return;
    const next = [...skipped, current.address];
    setSkipped(next);
    try {
      sessionStorage.setItem(SKIP_KEY, JSON.stringify(next));
    } catch {}
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && skip()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Name this wallet</DialogTitle>
          <DialogDescription>Give it a label so you can tell your wallets apart. You can change it any time from the wallet switcher.</DialogDescription>
        </DialogHeader>
        {current && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              renameWallet(current.address, draft || current.label || "My wallet");
              setDraft("");
            }}
          >
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <Identicon address={current.address} size={36} />
              <div className="font-mono text-xs text-muted-foreground">{short(current.address)}</div>
            </div>
            <Input autoFocus placeholder={current.label || "e.g. Everyday, Savings, Work"} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={skip}>Skip</Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
