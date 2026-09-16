"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Fingerprint, ShieldCheck, Zap } from "lucide-react";
import { ConnectButtons } from "@/components/connect-button";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/use-wallet";

export default function Home() {
  const router = useRouter();
  const { isConnected } = useWallet();

  return (
    <div className="mx-auto max-w-2xl space-y-10 py-10">
      <section className="space-y-4 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">ACME · on Tempo</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">A dollar you can send like a text.</h1>
        <p className="mx-auto max-w-lg text-lg text-muted-foreground">
          AcmeUSD is ACME&apos;s stablecoin. Buy it with USD, send it anywhere in a second, cash out whenever. Your wallet is just a passkey.
        </p>
        <div className="flex justify-center pt-2">
          {isConnected ? (
            <Button nativeButton={false} size="lg" render={<Link href="/wallet" />}>
              Open wallet <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <ConnectButtons size="lg" onConnected={() => router.push("/wallet")} />
          )}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: Fingerprint, title: "Passkey wallet", body: "No seed phrase. Face ID, Touch ID or a security key signs every transaction — natively on Tempo." },
          { icon: Zap, title: "Fees in AcmeUSD", body: "Tempo has no gas token. Every transfer pays its tiny fee in the same dollars you're sending." },
          { icon: ShieldCheck, title: "1:1 and auditable", body: "Every AcmeUSD is minted against a USD deposit and burned on cash-out. Admins reconcile chain vs. ledger live." },
        ].map((f) => (
          <div key={f.title} className="rounded-xl border bg-background p-4">
            <f.icon className="mb-2 h-5 w-5" />
            <h3 className="font-medium">{f.title}</h3>
            <p className="text-sm text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
