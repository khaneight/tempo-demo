"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight, Fingerprint, Loader2 } from "lucide-react";
import { isAddress, pad, stringToHex, type Hex } from "viem";
import { Hooks } from "wagmi/tempo";
import { AmountInput } from "@/components/amount-input";
import { Identicon } from "@/components/identicon";
import { Amount, TxLink } from "@/components/order-status";
import { ResultScreen } from "@/components/result-screen";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AmountError, FEE_BUFFER, formatAmount, parseAmount } from "@/lib/amounts";
import { ACME_USD, short } from "@/lib/client-config";
import { useAcmeBalance, useWallet } from "@/lib/use-wallet";
import { useWallets } from "@/lib/use-wallets";

type Phase = "form" | "confirm" | "signing" | "done" | "error";

/** Transfer AcmeUSD: pick a recipient (any address or one of your own wallets), review, sign with the passkey. */
export function SendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { address } = useWallet();
  const { wallets } = useWallets();
  const balance = useAcmeBalance(address);
  const transfer = Hooks.token.useTransferSync();
  const [phase, setPhase] = useState<Phase>("form");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: Hex; amount: bigint } | null>(null);
  const max = balance.data !== undefined && balance.data > FEE_BUFFER ? balance.data - FEE_BUFFER : 0n;

  const recipient = to.trim();
  const validAddress = isAddress(recipient) && recipient.toLowerCase() !== address;
  const ownWallet = wallets.find((w) => w.address === recipient.toLowerCase());
  const others = wallets.filter((w) => w.address !== address);

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (!isAddress(recipient)) throw new AmountError("Enter a valid Tempo address");
      if (recipient.toLowerCase() === address) throw new AmountError("That's your own address");
      const value = parseAmount(amount);
      if (balance.data !== undefined && value + FEE_BUFFER > balance.data) throw new AmountError(`Keep ${formatAmount(FEE_BUFFER)} for the fee — max ${formatAmount(max)}`);
      if (memo && new TextEncoder().encode(memo).length > 32) throw new AmountError("Memo must be 32 bytes or less");
      setPhase("confirm");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sign() {
    setPhase("signing");
    setError(null);
    try {
      const value = parseAmount(amount);
      const res = await transfer.mutateAsync({ token: ACME_USD, to: recipient as `0x${string}`, amount: value, memo: memo ? pad(stringToHex(memo), { size: 32 }) : undefined, feeToken: ACME_USD });
      setSent({ hash: res.receipt.transactionHash, amount: value });
      setPhase("done");
      void balance.refetch();
      void qc.invalidateQueries({ queryKey: ["activity"] });
    } catch (err) {
      const m = (err as Error).message ?? String(err);
      setError(/not allowed|cancel|abort|focus/i.test(m) ? "Passkey prompt was cancelled." : m.split("\n")[0]);
      setPhase("error");
    }
  }

  function reset() {
    setPhase("form");
    setSent(null);
    setError(null);
    setAmount("");
    setMemo("");
    setTo("");
  }
  function close(v: boolean) {
    onOpenChange(v);
    if (!v) reset();
  }

  const recipientCard = (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <Identicon address={recipient} size={40} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{ownWallet ? `${ownWallet.label || "Your wallet"} (yours)` : "Recipient"}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{recipient}</div>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send</DialogTitle>
          <DialogDescription>Settles in about a second on Tempo. The network fee is paid in AcmeUSD.</DialogDescription>
        </DialogHeader>

        {phase === "form" && (
          <form onSubmit={review} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="send-to">Recipient</Label>
              {others.length > 0 && (
                <select
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                  value={ownWallet ? ownWallet.address : ""}
                  onChange={(e) => setTo(e.target.value)}
                  aria-label="One of your wallets"
                >
                  <option value="">Choose one of your wallets…</option>
                  {others.map((w) => (
                    <option key={w.address} value={w.address}>
                      {w.label || "Wallet"} · {short(w.address)}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex items-center gap-2">
                {isAddress(recipient) ? <Identicon address={recipient} size={28} /> : <span className="inline-block h-7 w-7 shrink-0 rounded-full border border-dashed" />}
                <Input id="send-to" placeholder="0x… or pick a wallet above" value={to} onChange={(e) => setTo(e.target.value.trim())} className="font-mono" autoComplete="off" aria-invalid={recipient.length > 0 && !validAddress} />
              </div>
              {recipient.length > 0 && !isAddress(recipient) && <p className="text-xs text-destructive">Not a valid address</p>}
              {isAddress(recipient) && recipient.toLowerCase() === address && <p className="text-xs text-destructive">That&apos;s your active wallet</p>}
              {ownWallet && validAddress && <p className="text-xs text-muted-foreground">Sending to your own wallet “{ownWallet.label || "Wallet"}”.</p>}
            </div>
            <AmountInput value={amount} onChange={setAmount} max={formatAmount(max)} onMax={() => setAmount(formatAmount(max).replaceAll(",", ""))} hint={`Balance ${balance.data !== undefined ? formatAmount(balance.data) : "…"} · fee ≈ $0.001, ${formatAmount(FEE_BUFFER)} reserved`} />
            <div className="space-y-1.5">
              <Label htmlFor="send-memo">Memo (optional, on-chain, ≤ 32 bytes)</Label>
              <Input id="send-memo" placeholder="Invoice 42" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!validAddress || !amount}>Review <ArrowRight className="h-4 w-4" /></Button>
          </form>
        )}

        {(phase === "confirm" || phase === "signing") && (
          <div className="space-y-4">
            {recipientCard}
            <dl className="space-y-1 rounded-lg border p-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Amount</dt><dd className="font-mono tabular-nums">{formatAmount(parseAmount(amount))} AcmeUSD</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Network fee</dt><dd className="font-mono tabular-nums">≈ 0.001 AcmeUSD</dd></div>
              {memo && <div className="flex justify-between"><dt className="text-muted-foreground">Memo</dt><dd className="font-mono">{memo}</dd></div>}
              <div className="flex justify-between"><dt className="text-muted-foreground">From</dt><dd className="font-mono text-xs">{short(address ?? "")}</dd></div>
            </dl>
            <p className="text-xs text-muted-foreground">Transfers on Tempo are final. Check the address before you sign.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setPhase("form")} disabled={phase === "signing"}>Back</Button>
              <Button className="flex-1" onClick={sign} disabled={phase === "signing"}>
                {phase === "signing" ? <><Loader2 className="h-4 w-4 animate-spin" /> Confirm in your passkey…</> : <><Fingerprint className="h-4 w-4" /> Confirm & sign</>}
              </Button>
            </div>
          </div>
        )}

        {phase === "done" && sent && (
          <ResultScreen kind="success" title={<>Sent <Amount value={sent.amount} /></>} actions={<><Button variant="outline" onClick={reset}>Send another</Button><Button onClick={() => close(false)}>Done</Button></>}>
            <div className="flex flex-col items-center gap-2">
              <span className="inline-flex items-center gap-1.5">to <Identicon address={recipient} size={18} /> <span className="font-mono">{short(recipient)}</span>{ownWallet ? ` (${ownWallet.label || "your wallet"})` : ""}</span>
              <TxLink hash={sent.hash} />
            </div>
          </ResultScreen>
        )}

        {phase === "error" && (
          <ResultScreen kind="error" title="Transfer not sent" actions={<><Button variant="outline" onClick={() => setPhase("confirm")}>Try again</Button><Button variant="ghost" onClick={() => close(false)}>Close</Button></>}>
            {error} Nothing left your wallet.
          </ResultScreen>
        )}
      </DialogContent>
    </Dialog>
  );
}
