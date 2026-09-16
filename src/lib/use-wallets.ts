"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConnect, useConnectors } from "wagmi";
import { useWallet } from "./use-wallet";

/**
 * A person can own several passkey wallets on one device (each "Create a new
 * wallet" registers a new passkey → new address). The accounts SDK remembers
 * connected accounts, but "Sign out" wipes that list, so we also keep a small
 * registry in localStorage: { address, credentialId, label }. Switching is a
 * `wallet_connect` with that wallet's credentialId — one passkey confirmation.
 */
export type KnownWallet = { address: `0x${string}`; credentialId: string; label: string; addedAt: number };

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
export function rememberWallet(w: Omit<KnownWallet, "addedAt">) {
  const cur = read();
  const address = w.address.toLowerCase() as `0x${string}`;
  const existing = cur.find((x) => x.address === address);
  write(existing ? cur.map((x) => (x.address === address ? { ...x, credentialId: w.credentialId, label: w.label || x.label } : x)) : [...cur, { ...w, address, addedAt: Date.now() }]);
}
export function forgetWallet(address: string) {
  write(read().filter((x) => x.address !== address.toLowerCase()));
}
const EMPTY: KnownWallet[] = [];

type SdkAccount = { address: string; label?: string; credential?: { id: string } };
type SdkStore = { getState(): { accounts: readonly SdkAccount[] }; subscribe(cb: () => void): () => void };

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

  // Seed/refresh the registry from the SDK's own store whenever it changes.
  const [store, setStore] = useState<SdkStore | null>(null);
  useEffect(() => {
    let alive = true;
    connector
      ?.getProvider()
      .then((p) => alive && setStore(((p as { store?: SdkStore }).store ?? null)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connector]);
  useEffect(() => {
    if (!store) return;
    const sync = () => {
      for (const a of store.getState().accounts) {
        if (a.credential?.id) rememberWallet({ address: a.address as `0x${string}`, credentialId: a.credential.id, label: a.label ?? "" });
      }
    };
    sync();
    return store.subscribe(sync);
  }, [store]);

  /**
   * wagmi's `connect()` refuses while already connected, and the connector skips
   * `wallet_connect` when it has accounts — so while connected we talk to the
   * provider directly; it emits `accountsChanged` and wagmi follows.
   */
  const connectWith = useCallback(
    async (capabilities: Record<string, unknown>) => {
      if (active) {
        const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
        await provider.request({ method: "wallet_connect", params: [{ capabilities }] });
      } else {
        await connectAsync({ connector, capabilities } as Parameters<typeof connectAsync>[0]);
      }
      await qc.invalidateQueries();
    },
    [active, connectAsync, connector, qc],
  );

  const switchTo = useCallback((w: KnownWallet) => connectWith({ credentialId: w.credentialId }), [connectWith]);
  const create = useCallback((label: string) => connectWith({ method: "register", name: label }), [connectWith]);

  return { wallets, active, switchTo, create, busy: isPending };
}
