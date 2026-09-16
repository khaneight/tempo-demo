"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type OfframpDto, type OnrampDto } from "./api-client";
import { uiState } from "@/components/order-status";

type Kind = "onramp" | "offramp";
type Dto<K extends Kind> = K extends "onramp" ? OnrampDto : OfframpDto;
type ProcessResponse<K extends Kind> = { order: Dto<K>; inProgress: boolean; message?: string };

/**
 * Keeps an order moving while a dialog or page is watching it: re-drives it every
 * few seconds while pending (idempotent server-side), exposes a manual retry, and
 * settles once the order reaches a terminal state.
 */
export function useOrder<K extends Kind>(kind: K, initial: Dto<K> | null) {
  const qc = useQueryClient();
  const [order, setOrder] = useState<Dto<K> | null>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const id = order?.id;
  const state = order ? uiState(order.status as never) : null;
  const pending = state === "pending" || state === "in_progress";
  // A poll/retry that resolves after the dialog was closed (order cleared) or switched must not resurrect it.
  const idRef = useRef(id);
  useEffect(() => {
    idRef.current = id;
  }, [id]);

  const apply = (r: ProcessResponse<K>) => {
    if (idRef.current !== r.order.id) return;
    setOrder(r.order);
    setMessage(r.message ?? null);
    if (uiState(r.order.status as never) === "done") void qc.invalidateQueries({ queryKey: ["activity"] });
  };

  useQuery({
    queryKey: ["order-drive", kind, id],
    queryFn: async () => {
      const r = await api<ProcessResponse<K>>(`/api/${kind}/${id}/process`, { method: "POST", json: {} }).catch((e) => {
        if (e instanceof ApiError && e.status === 409) return null;
        throw e;
      });
      if (r) apply(r);
      return r;
    },
    enabled: !!id && pending,
    refetchInterval: 4000,
    retry: false,
  });

  const retry = useMutation({
    mutationFn: (body: { txHash?: string } = {}) => api<ProcessResponse<K>>(`/api/${kind}/${id}/process`, { method: "POST", json: body }),
    onSuccess: apply,
    onError: (e) => setMessage(e instanceof ApiError && e.status === 409 ? "Still processing…" : (e as Error).message),
  });

  return { order, setOrder, state, pending, message, retry, busy: retry.isPending };
}
