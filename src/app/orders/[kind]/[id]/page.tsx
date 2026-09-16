"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Amount, OFFRAMP_STEPS, ONRAMP_STEPS, StatusBadge, Timeline, TxLink, uiState } from "@/components/order-status";
import { OfframpTransferStep } from "@/components/offramp-transfer-step";
import { RequireWallet } from "@/components/require-wallet";
import { api, ApiError, type OfframpDto, type OnrampDto } from "@/lib/api-client";

type Dto = OnrampDto | OfframpDto;
type ProcessResponse = { order: Dto; inProgress: boolean; message?: string };

function Inner({ kind, id }: { kind: "onramp" | "offramp"; id: string }) {
  const qc = useQueryClient();
  const key = ["order", kind, id];
  const [message, setMessage] = useState<string | null>(null);

  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ order: Dto }>(`/api/orders/${kind}/${id}`).then((r) => r.order),
  });
  const order = q.data;
  const s = order ? uiState(order.status) : null;

  const process = useMutation({
    mutationFn: (body: { txHash?: string } = {}) => api<ProcessResponse>(`/api/${kind}/${id}/process`, { method: "POST", json: body }),
    onSuccess: (r) => {
      qc.setQueryData(key, r.order);
      setMessage(r.message ?? null);
    },
    onError: (e) => setMessage(e instanceof ApiError && e.status === 409 ? "Still processing…" : (e as Error).message),
  });

  // Keep driving the order while something is in flight (a stuck order is re-driven, never duplicated).
  useQuery({
    queryKey: [...key, "drive"],
    queryFn: async () => {
      const r = await api<ProcessResponse>(`/api/${kind}/${id}/process`, { method: "POST", json: {} }).catch((e) => {
        if (e instanceof ApiError && e.status === 409) return null;
        throw e;
      });
      if (r) qc.setQueryData(key, r.order);
      return r;
    },
    enabled: s === "pending" || s === "in_progress",
    refetchInterval: 4000,
    retry: false,
  });

  if (q.error) return <Alert variant="destructive"><AlertTitle>Couldn’t load order</AlertTitle><AlertDescription>{(q.error as Error).message}</AlertDescription></Alert>;
  if (!order || !s) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  const steps = kind === "onramp" ? ONRAMP_STEPS : OFFRAMP_STEPS;
  const off = kind === "offramp" ? (order as OfframpDto) : null;
  const on = kind === "onramp" ? (order as OnrampDto) : null;
  const awaitingTransfer = !!off && (off.status === "created" || off.status === "expired");
  const busy = process.isPending;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>{kind === "onramp" ? "Buy AcmeUSD" : "Cash out AcmeUSD"}</CardTitle>
              <CardDescription className="mt-1 text-lg text-foreground"><Amount value={order.amount} /></CardDescription>
            </div>
            <StatusBadge status={order.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Timeline steps={steps} status={order.status} kind={kind} />

          {off && awaitingTransfer && <OfframpTransferStep order={off} onSubmitted={(txHash) => process.mutate({ txHash })} busy={busy} />}

          {s === "done" && (
            <Alert>
              <AlertTitle>{kind === "onramp" ? "AcmeUSD is in your wallet" : "USD is on its way to your bank"}</AlertTitle>
              <AlertDescription className="flex flex-col gap-1">
                {on && <TxLink hash={on.mintTxHash} label="Mint transaction" />}
                {off && <TxLink hash={off.transferTxHash} label="Your transfer" />}
                {off && <TxLink hash={off.burnTxHash} label="Burn transaction" />}
              </AlertDescription>
            </Alert>
          )}
          {s === "failed" && (
            <Alert variant="destructive">
              <AlertTitle>We couldn’t complete this order</AlertTitle>
              <AlertDescription>Your USD payment has been refunded. {order.lastError}</AlertDescription>
            </Alert>
          )}
          {s === "review" && (
            <Alert variant="destructive">
              <AlertTitle>Needs a human look</AlertTitle>
              <AlertDescription>
                {off ? "Your funds are safe with ACME; support will finish this manually. " : "Your payment is on hold; support will finish this manually. "}
                {order.lastError}
              </AlertDescription>
            </Alert>
          )}
          {(s === "pending" || s === "in_progress") && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {order.lastError ? `Retrying: ${order.lastError}` : "Working on it — you can close this page and come back."}
            </div>
          )}
          {message && <p className="text-sm text-muted-foreground">{message}</p>}

          {s !== "done" && s !== "failed" && s !== "review" && (
            <Button variant="outline" onClick={() => process.mutate({})} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {awaitingTransfer ? "I already sent it — check status" : "Retry / check status"}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">Order {order.id}</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrderPage({ params }: { params: Promise<{ kind: "onramp" | "offramp"; id: string }> }) {
  const { kind, id } = use(params);
  return (
    <RequireWallet>
      <Inner kind={kind} id={id} />
    </RequireWallet>
  );
}
