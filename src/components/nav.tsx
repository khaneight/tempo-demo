"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButtons, DisconnectButton } from "@/components/connect-button";

const links = [
  { href: "/wallet", label: "Wallet" },
  { href: "/onramp", label: "Buy" },
  { href: "/offramp", label: "Cash out" },
  { href: "/send", label: "Send" },
  { href: "/admin", label: "Admin" },
];

export function Nav() {
  const path = usePathname();
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
        <div className="ml-auto">
          <DisconnectButton />
          <ConnectButtons size="sm" compact />
        </div>
      </div>
    </header>
  );
}
