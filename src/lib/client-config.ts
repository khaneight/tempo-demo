/** Browser-safe config (inlined at build time via NEXT_PUBLIC_*). */
export const ACME_USD = (process.env.NEXT_PUBLIC_ACME_USD_ADDRESS ?? "").toLowerCase() as `0x${string}`;
export const TREASURY = (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "").toLowerCase() as `0x${string}`;
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://explore.testnet.tempo.xyz";

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
