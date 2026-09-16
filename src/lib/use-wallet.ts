"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { Abis } from "viem/tempo";
import { api } from "./api-client";
import { ACME_USD } from "./client-config";

/**
 * Wallet = wagmi passkey connection (signs transactions in the browser)
 * + server session cookie (authorizes /api/* calls, set by the same passkey ceremony).
 */
export function useWallet() {
  const { address, isConnected, status } = useAccount();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api<{ user: { address: `0x${string}`; credentialId: string } | null }>("/api/session"),
    staleTime: 30_000,
  });
  const sessionAddress = session.data?.user?.address ?? null;
  const mismatch = isConnected && session.isSuccess && sessionAddress !== (address?.toLowerCase() ?? null);
  return {
    address: address?.toLowerCase() as `0x${string}` | undefined,
    isConnected,
    connecting: status === "connecting" || status === "reconnecting",
    sessionAddress,
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
