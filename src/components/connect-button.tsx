"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { short } from "@/lib/client-config";
import { useWallet } from "@/lib/use-wallet";

type Mode = "create" | "signin";

/**
 * One passkey ceremony does both jobs: it creates/loads the on-chain account
 * in the browser AND establishes the server session cookie (same handler).
 *
 *  - create: `capabilities.method = 'register'` -> new passkey -> new address
 *  - signin: existing passkey (browser picker) -> same address as before
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
  /** Show even while wagmi is connected (server session expired): disconnect, then run the ceremony again. */
  reauth?: boolean;
}) {
  const qc = useQueryClient();
  const [connector] = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { isConnected } = useWallet();
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(m: Mode) {
    setMode(m);
    setError(null);
    try {
      if (isConnected) await disconnectAsync();
      await connectAsync({
        connector,
        ...(m === "create" ? { capabilities: { method: "register", name: `AcmeUSD wallet · ${new Date().toLocaleDateString()}` } } : {}),
      } as Parameters<typeof connectAsync>[0]);
      await qc.invalidateQueries({ queryKey: ["session"] });
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
  return (
    <div className="space-y-2">
      <div className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"} gap-2`}>
        <Button size={size} onClick={() => go("create")} disabled={isPending}>
          {busy("create") ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {compact ? "Create" : "Create a new wallet"}
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
        await api("/api/auth/logout", { method: "POST" }).catch(() => {});
        await disconnectAsync();
        await qc.invalidateQueries({ queryKey: ["session"] });
      }}
      title={address}
    >
      <span className="font-mono text-xs">{short(address ?? "")}</span> · Sign out
    </Button>
  );
}
