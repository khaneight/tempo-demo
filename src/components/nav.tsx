"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ConnectButtons, DisconnectButton } from "@/components/connect-button";
import { Identicon } from "@/components/identicon";
import { WalletSwitcher } from "@/components/wallet-switcher";
import { useWallet } from "@/lib/use-wallet";

const links = [
  { href: "/wallet", label: "Wallet" },
  { href: "/admin", label: "Admin" },
];

export function Nav() {
  const path = usePathname();
  const { address, isConnected } = useWallet();
  const [switcher, setSwitcher] = useState(false);
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          <span className="rounded bg-foreground px-1.5 py-0.5 text-background">ACME</span> USD
        </Link>
        <nav className="flex gap-1 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={`rounded-md px-2.5 py-1.5 hover:bg-muted ${path.startsWith(l.href) ? "bg-muted font-medium" : "text-muted-foreground"}`}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {isConnected && address && (
            <button type="button" onClick={() => setSwitcher(true)} className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-muted" title="Switch wallet">
              <Identicon address={address} size={24} />
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          <DisconnectButton />
          <ConnectButtons size="sm" compact />
        </div>
      </div>
      {isConnected && <WalletSwitcher open={switcher} onOpenChange={setSwitcher} />}
    </header>
  );
}
