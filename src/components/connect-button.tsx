"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Fingerprint, Loader2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useConnect, useConnectors, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { useWallet } from "@/lib/use-wallet";

/**
 * Register = pick a username, then set up a passkey (the identity's first wallet, "Main").
 * Sign in  = any passkey of an existing identity.
 * The same ceremony establishes the server session; a signed-in identity can add wallets later.
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
  const { connectAsync } = useConnect();
  const { isConnected } = useWallet();
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState<"register" | "signin" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useQuery({
    queryKey: ["username-available", username.trim().toLowerCase()],
    queryFn: () => api<{ ok: boolean; reason?: string }>(`/api/identity/available?username=${encodeURIComponent(username.trim())}`),
    enabled: registering && username.trim().length >= 3,
    staleTime: 10_000,
  });

  async function ceremony(capabilities?: Record<string, unknown>) {
    if (isConnected) {
      // Re-auth while connected (server session expired): talk to the provider directly so the
      // SDK's other remembered accounts are kept — a wagmi disconnect would wipe them all.
      const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
      await provider.request({ method: "wallet_connect", params: [capabilities ? { capabilities } : {}] });
    } else {
      await connectAsync({ connector, ...(capabilities ? { capabilities } : {}) } as Parameters<typeof connectAsync>[0]);
    }
  }

  async function go(kind: "register" | "signin") {
    setBusy(kind);
    setError(null);
    try {
      await ceremony(kind === "register" ? { method: "register", name: username.trim().toLowerCase() } : undefined);
      await qc.invalidateQueries({ queryKey: ["session"] });
      setRegistering(false);
      onConnected?.();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(
        /not allowed|cancel|abort|focus/i.test(msg)
          ? "Passkey prompt was cancelled or the window wasn't focused — try again."
          : /taken|Username/i.test(msg)
            ? msg.split("\n")[0]
            : msg.split("\n")[0],
      );
    } finally {
      setBusy(null);
    }
  }

  if (isConnected && !reauth) return null;

  if (registering) {
    const ok = check.data?.ok === true;
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void go("register");
        }}
      >
        <div className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"} gap-2`}>
          <div className="relative min-w-0 sm:w-60">
            <Input autoFocus placeholder="Pick a username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} autoCapitalize="off" autoCorrect="off" spellCheck={false} className="pr-7" />
            <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
              {check.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : check.data?.ok ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : check.data && username.trim().length >= 3 ? <X className="h-3.5 w-3.5 text-destructive" /> : null}
            </span>
          </div>
          <Button size={size} type="submit" disabled={!ok || busy !== null}>
            {busy === "register" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} Set up passkey
          </Button>
          <Button size={size} type="button" variant="ghost" onClick={() => setRegistering(false)} disabled={busy !== null}>Cancel</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {check.data && !check.data.ok && username.trim().length >= 3 ? <span className="text-destructive">{check.data.reason}</span> : "3–24 characters: letters, numbers, _ or -. Your passkey becomes your first wallet."}
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`flex ${compact ? "flex-row" : "flex-col sm:flex-row"} gap-2`}>
        <Button size={size} onClick={() => setRegistering(true)} disabled={busy !== null}>
          <UserPlus className="h-4 w-4" /> Register
        </Button>
        <Button size={size} variant="outline" onClick={() => go("signin")} disabled={busy !== null}>
          {busy === "signin" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} {compact ? "Sign in" : "Sign in with passkey"}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function DisconnectButton() {
  const qc = useQueryClient();
  const { disconnectAsync } = useDisconnect();
  const { isConnected, identity } = useWallet();
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
    >
      {identity?.username && <span className="font-medium">@{identity.username}</span>}
      <span className="text-muted-foreground">· Sign out</span>
    </Button>
  );
}
