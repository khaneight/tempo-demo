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
};

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
    connector
      ?.getProvider()
      .then((p) => alive && setStore((p as { store?: SdkStore }).store ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connector]);

  /** Passkey ceremony path. */
  const connectWith = useCallback(
    async (capabilities: Record<string, unknown>) => {
      if (active) {
        // wagmi's connect() refuses while connected and the connector skips wallet_connect when it
        // already has accounts — so talk to the provider; it emits accountsChanged and wagmi follows.
        const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
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

  /** New passkey under this identity; the server attaches it because the request carries our session. */
  const create = useCallback((label: string) => connectWith({ method: "register", name: label.trim() || "Wallet" }), [connectWith]);

  const rename = useCallback(
    async (address: string, label: string) => {
      await api(`/api/wallets/${address}`, { method: "PATCH", json: { label } });
      await qc.invalidateQueries({ queryKey: ["session"] });
    },
    [qc],
  );

  return { username, wallets, active, switchTo, create, rename, busy: isPending };
}
