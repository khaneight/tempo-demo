"use client";

import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectButtons } from "@/components/connect-button";
import { useWallet } from "@/lib/use-wallet";

/** Gate: needs both a connected passkey wallet and a matching server session. */
export function RequireWallet({ children }: { children: React.ReactNode }) {
  const w = useWallet();
  if (w.connecting || (w.isConnected && w.sessionLoading)) {
    return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</div>;
  }
  if (!w.isConnected || w.sessionMissing || w.sessionMismatch) {
    return (
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>{w.isConnected ? "Session expired" : "Your wallet is a passkey"}</CardTitle>
            <CardDescription>
              {w.isConnected
                ? "Confirm with your passkey again to continue."
                : "Create a new wallet or sign in to an existing one with Face ID, Touch ID or a security key. No seed phrases."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectButtons />
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
