"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { Abis } from "viem/tempo";
import { api } from "./api-client";
import { ACME_USD } from "./client-config";

export type SessionWallet = { address: `0x${string}`; credentialId: string; label: string };
export type SessionInfo = {
  user: { address: `0x${string}`; credentialId: string } | null;
  identity: { username: string; wallets: SessionWallet[] } | null;
};

/**
 * Wallet = wagmi passkey connection (signs transactions in the browser)
 * + server session (authorizes /api/* calls for any wallet of the signed-in identity).
 */
export function useWallet() {
  const { address, isConnected, status } = useAccount();
  const session = useQuery({
    queryKey: ["session", address?.toLowerCase()],
    queryFn: () => api<SessionInfo>("/api/session"),
    staleTime: 30_000,
  });
  const sessionAddress = session.data?.user?.address ?? null;
  const mismatch = isConnected && session.isSuccess && sessionAddress !== (address?.toLowerCase() ?? null);
  return {
    address: address?.toLowerCase() as `0x${string}` | undefined,
    isConnected,
    connecting: status === "connecting" || status === "reconnecting",
    sessionAddress,
    identity: session.data?.identity ?? null,
    sessionLoading: session.isLoading,
    sessionMissing: isConnected && session.isSuccess && !sessionAddress,
    sessionMismatch: mismatch,
    refetchSession: session.refetch,
  };
}

export function useAcmeBalance(address?: `0x${string}`) {
  return useReadContract({
    address: ACME_USD,
    abi: Abis.tip20,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 5_000 },
  });
}
