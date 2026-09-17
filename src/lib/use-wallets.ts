"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { api } from "./api-client";
import { useWallet, type SessionWallet } from "./use-wallet";

/**
 * An identity's wallets come from the server (`/api/session`), so the list and
 * labels follow the username across devices.
 *
 * Switching does not prompt the passkey when the SDK already holds that account
 * in this browser (a local reorder of its store; wagmi follows `accountsChanged`).
 * A wallet never used on this device needs one passkey confirmation
 * (`wallet_connect` with its credential id) — after that it's remembered.
 * The server accepts any wallet of the signed-in identity via the `x-wallet` header.
 */
type SdkAccount = { address: string; label?: string; credential?: { id: string } };
type SdkStore = {
  getState(): { accounts: readonly SdkAccount[]; activeAccount: number };
  setState(p: Partial<{ accounts: readonly SdkAccount[]; activeAccount: number }>): void;
  persist?: { hasHydrated(): boolean; onFinishHydration(cb: () => void): () => void };
};
type SdkProvider = { request(a: { method: string; params?: unknown[] }): Promise<unknown>; store?: SdkStore };

/**
 * The SDK's account store is persisted in IndexedDB and rehydrates asynchronously
 * after the provider is created. A ceremony that finishes before rehydration gets
 * its freshly stored account overwritten by the (older) snapshot — which showed up
 * as "creating a wallet only works on the second try". Always wait for hydration.
 */
export async function readyProvider(connector: { getProvider(): Promise<unknown> }): Promise<SdkProvider> {
  const provider = (await connector.getProvider()) as SdkProvider;
  const persist = provider.store?.persist;
  if (persist && !persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const off = persist.onFinishHydration(() => {
        off();
        resolve();
      });
      setTimeout(resolve, 3000); // never hang the UI on a broken IndexedDB
    });
  }
  return provider;
}

export function useWallets() {
  const qc = useQueryClient();
  const [connector] = useConnectors();
  const { connectAsync, isPending } = useConnect();
  const { address: active, identity } = useWallet();
  const wallets: SessionWallet[] = identity?.wallets ?? [];
  const username = identity?.username ?? null;

  const [store, setStore] = useState<SdkStore | null>(null);
  useEffect(() => {
    let alive = true;
    if (!connector) return;
    readyProvider(connector)
      .then((p) => alive && setStore(p.store ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connector]);

  /** Passkey ceremony path. */
  const connectWith = useCallback(
    async (capabilities: Record<string, unknown>) => {
      const provider = await readyProvider(connector);
      if (active) {
        // wagmi's connect() refuses while connected and the connector skips wallet_connect when it
        // already has accounts — so talk to the provider; it emits accountsChanged and wagmi follows.
        await provider.request({ method: "wallet_connect", params: [{ capabilities }] });
      } else {
        await connectAsync({ connector, capabilities } as Parameters<typeof connectAsync>[0]);
      }
      await qc.invalidateQueries();
    },
    [active, connectAsync, connector, qc],
  );

  const switchTo = useCallback(
    async (w: SessionWallet) => {
      if (w.address === active) return;
      const accounts = store?.getState().accounts ?? [];
      const idx = accounts.findIndex((a) => a.address.toLowerCase() === w.address);
      if (store && idx >= 0) {
        const next = [accounts[idx], ...accounts.filter((_, i) => i !== idx)];
        store.setState({ accounts: next, activeAccount: 0 });
        await qc.invalidateQueries();
        return;
      }
      await connectWith({ credentialId: w.credentialId });
    },
    [active, connectWith, qc, store],
  );

  /**
   * New passkey under this identity. The passkey's own label stays the username (that's what
   * the OS shows); the wallet label is parked server-side first and applied by onRegister.
   */
  const create = useCallback(
    async (label: string) => {
      await api("/api/wallets/pending-label", { method: "POST", json: { label: label.trim() || "Wallet" } });
      // The SDK short-circuits `register` to a sign-in when a stored account already carries the same
      // label — and every passkey of an identity is labelled with the username. Our UI names wallets
      // from the server, so relabel the SDK's copies to their addresses before registering.
      if (store) {
        const accounts = store.getState().accounts;
        if (accounts.some((a) => (a.label ?? "").toLowerCase() === (username ?? "").toLowerCase())) {
          store.setState({ accounts: accounts.map((a) => ({ ...a, label: a.address })) });
        }
      }
      await connectWith({ method: "register", name: username ?? "wallet" });
    },
    [connectWith, store, username],
  );

  const rename = useCallback(
    async (address: string, label: string) => {
      await api(`/api/wallets/${address}`, { method: "PATCH", json: { label } });
      await qc.invalidateQueries({ queryKey: ["session"] });
    },
    [qc],
  );

  return { username, wallets, active, switchTo, create, rename, busy: isPending };
}
