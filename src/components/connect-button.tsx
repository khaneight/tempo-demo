"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { short } from "@/lib/client-config";
import { useWallet } from "@/lib/use-wallet";
import { linkCurrentSession, renameWallet } from "@/lib/use-wallets";
import { getAccount } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";

type Mode = "create" | "signin";

/**
 * One passkey ceremony does both jobs: it creates/loads the on-chain account
 * in the browser AND establishes the server session cookie (same handler).
 *
 *  - create: asks for a name first, then `capabilities.method = 'register'` -> new passkey -> new address
 *  - signin: existing passkey (browser picker) -> same address as before
 *    (a wallet seen for the first time on this device is asked for a name afterwards — see NameWalletPrompt)
 */
export function ConnectButtons({
  size = "default",
  onConnected,
  compact = false,
  reauth = false,
}: {
  size?: "default" | "lg" | "sm";
  onConnected?: () => void;
  compact?: boolean;
  /** Show even while wagmi is connected (server session expired): re-run the ceremony without dropping other wallets. */
  reauth?: boolean;
}) {
  const qc = useQueryClient();
  const [connector] = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { isConnected } = useWallet();
  const [mode, setMode] = useState<Mode | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function go(m: Mode, label?: string) {
    setMode(m);
    setError(null);
    try {
      const capabilities = m === "create" ? { method: "register", name: label?.trim() || "My wallet" } : undefined;
      if (isConnected) {
        // Re-auth while connected (server session expired): talk to the provider directly so the
        // SDK's other remembered accounts are kept — a wagmi disconnect would wipe them all.
        const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
        await provider.request({ method: "wallet_connect", params: [capabilities ? { capabilities } : {}] });
      } else {
        await connectAsync({ connector, ...(capabilities ? { capabilities } : {}) } as Parameters<typeof connectAsync>[0]);
      }
      await linkCurrentSession();
      if (m === "create") {
        const created = getAccount(wagmiConfig()).address;
        if (created) renameWallet(created, label?.trim() || "My wallet");
      }
      await qc.invalidateQueries({ queryKey: ["session"] });
      setNaming(false);
      onConnected?.();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(/not allowed|cancel|abort|focus/i.test(msg) ? "Passkey prompt was cancelled or the window wasn't focused — try again." : msg.split("\n")[0]);
    } finally {
      setMode(null);
    }
  }

  if (isConnected && !reauth) return null;
  const busy = (m: Mode) => isPending && mode === m;

  if (naming) {
    return (
      <form
        className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"} gap-2`}
        onSubmit={(e) => {
          e.preventDefault();
          void go("create", name);
        }}
      >
        <Input autoFocus placeholder="Name your wallet (e.g. Everyday)" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="min-w-0 sm:w-56" />
        <Button size={size} type="submit" disabled={isPending}>
          {busy("create") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} Create with passkey
        </Button>
        <Button size={size} type="button" variant="ghost" onClick={() => setNaming(false)} disabled={isPending}>Cancel</Button>
        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </form>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"} gap-2`}>
        <Button size={size} onClick={() => setNaming(true)} disabled={isPending}>
          <UserPlus className="h-4 w-4" /> {compact ? "Create" : "Create a new wallet"}
        </Button>
        <Button size={size} variant="outline" onClick={() => go("signin")} disabled={isPending}>
          {busy("signin") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} {compact ? "Sign in" : "Sign in with existing passkey"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function DisconnectButton() {
  const qc = useQueryClient();
  const { disconnectAsync } = useDisconnect();
  const { address, isConnected } = useWallet();
  if (!isConnected) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await Promise.all([api("/api/auth/logout", { method: "POST" }).catch(() => {}), api("/api/session/link", { method: "DELETE" }).catch(() => {})]);
        await disconnectAsync();
        await qc.invalidateQueries({ queryKey: ["session"] });
      }}
      title={address}
    >
      <span className="font-mono text-xs">{short(address ?? "")}</span> · Sign out
    </Button>
  );
}
