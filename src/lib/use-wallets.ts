"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConnect, useConnectors } from "wagmi";
import { api } from "./api-client";
import { useWallet } from "./use-wallet";

/**
 * A person can own several passkey wallets on one device (each "Create a new
 * wallet" registers a new passkey → new address).
 *
 * Switching does NOT prompt the passkey: the SDK store keeps every account that
 * has connected in this browser, so switching is a local reorder of that store
 * (wagmi follows via `accountsChanged`), and the server accepts the wallet via the
 * signed linked-wallets cookie it recorded when that wallet last signed in.
 * Only two things ever prompt: signing in a wallet for the first time (or after
 * "Sign out"), and signing a transaction.
 *
 * We also keep a small registry in localStorage ({ address, credentialId, label })
 * so the list and labels survive "Sign out" (which wipes the SDK store).
 */
export type KnownWallet = { address: `0x${string}`; credentialId: string; label: string };

const KEY = "acmeusd.wallets";
const listeners = new Set<() => void>();
let cache: KnownWallet[] | null = null;

function read(): KnownWallet[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "[]") as KnownWallet[];
  } catch {
    cache = [];
  }
  return cache;
}
function write(next: KnownWallet[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l());
}
export function rememberWallet(w: KnownWallet) {
  const cur = read();
  const address = w.address.toLowerCase() as `0x${string}`;
  const existing = cur.find((x) => x.address === address);
  if (existing && existing.credentialId === w.credentialId && (existing.label || !w.label)) return; // nothing new
  write(existing ? cur.map((x) => (x.address === address ? { ...x, credentialId: w.credentialId, label: x.label || w.label } : x)) : [...cur, { ...w, address }]);
}
export function renameWallet(address: string, label: string) {
  write(read().map((x) => (x.address === address.toLowerCase() ? { ...x, label: label.trim() } : x)));
}
const EMPTY: KnownWallet[] = [];

type SdkAccount = { address: string; label?: string; credential?: { id: string } };
type SdkStore = { getState(): { accounts: readonly SdkAccount[]; activeAccount: number }; setState(p: Partial<{ accounts: readonly SdkAccount[]; activeAccount: number }>): void; subscribe(cb: () => void): () => void };

/** Record the current passkey session's wallet server-side so future switches to it need no prompt. */
export async function linkCurrentSession() {
  await api("/api/session/link", { method: "POST", json: {} }).catch(() => {});
}

export function useWallets() {
  const qc = useQueryClient();
  const [connector] = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { address: active } = useWallet();

  const wallets = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => EMPTY,
  );

  const [store, setStore] = useState<SdkStore | null>(null);
  useEffect(() => {
    let alive = true;
    connector
      ?.getProvider()
      .then((p) => alive && setStore((p as { store?: SdkStore }).store ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connector]);
  // Mirror the SDK's accounts (and their labels) into the registry.
  useEffect(() => {
    if (!store) return;
    let last: readonly SdkAccount[] | null = null;
    const sync = () => {
      const accounts = store.getState().accounts;
      if (accounts === last) return; // the store fires on every change (chainId, auth…); only accounts matter here
      last = accounts;
      for (const a of accounts) {
        if (a.credential?.id) rememberWallet({ address: a.address as `0x${string}`, credentialId: a.credential.id, label: a.label ?? "" });
      }
    };
    sync();
    return store.subscribe(sync);
  }, [store]);

  /** Passkey ceremony path (first sign-in of a wallet, or after sign-out). */
  const connectWith = useCallback(
    async (capabilities: Record<string, unknown>) => {
      if (active) {
        const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
        await provider.request({ method: "wallet_connect", params: [{ capabilities }] });
      } else {
        await connectAsync({ connector, capabilities } as Parameters<typeof connectAsync>[0]);
      }
      await linkCurrentSession();
      await qc.invalidateQueries();
    },
    [active, connectAsync, connector, qc],
  );

  const switchTo = useCallback(
    async (w: KnownWallet) => {
      if (w.address === active) return;
      const accounts = store?.getState().accounts ?? [];
      const idx = accounts.findIndex((a) => a.address.toLowerCase() === w.address);
      if (store && idx >= 0) {
        // Local switch, no prompt: put the chosen account first; the SDK emits accountsChanged.
        const next = [accounts[idx], ...accounts.filter((_, i) => i !== idx)];
        store.setState({ accounts: next, activeAccount: 0 });
        await qc.invalidateQueries();
        return;
      }
      await connectWith({ credentialId: w.credentialId });
    },
    [active, connectWith, qc, store],
  );

  const create = useCallback((label: string) => connectWith({ method: "register", name: label }), [connectWith]);

  return { wallets, active, switchTo, create, busy: isPending };
}
