"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Amount, StatusBadge, TxLink } from "@/components/order-status";
import type { OfframpDto, OnrampDto } from "@/lib/api-client";

export function OrderRow({ kind, order }: { kind: "onramp" | "offramp"; order: OnrampDto | OfframpDto }) {
  const hash = kind === "onramp" ? (order as OnrampDto).mintTxHash : (order as OfframpDto).burnTxHash ?? (order as OfframpDto).transferTxHash;
  return (
    <Link href={`/orders/${kind}/${order.id}`} className="block rounded-lg border p-3 hover:bg-muted/50">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{kind === "onramp" ? "Buy" : "Cash out"} · <Amount value={order.amount} /></div>
          <div className="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleString()}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={order.status} />
          <TxLink hash={hash} label="tx" />
        </div>
      </div>
    </Link>
  );
}

export function OrderList({ title, kind, orders }: { title: string; kind: "onramp" | "offramp"; orders: (OnrampDto | OfframpDto)[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {orders.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
        {orders.map((o) => (
          <OrderRow key={o.id} kind={kind} order={o} />
        ))}
      </CardContent>
    </Card>
  );
}
