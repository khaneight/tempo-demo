import { createConfig, http } from "wagmi";
import { tempoModerato } from "wagmi/chains";
import { webAuthn } from "wagmi/tempo";

/**
 * Passkey wallets on Tempo testnet. The `auth.url` points at our server
 * ceremony (accounts/server Handler.webAuthn) so credential public keys are
 * stored in Postgres and the same wallet address is recoverable from any device.
 */
export function makeWagmiConfig() {
  return createConfig({
    chains: [tempoModerato],
    connectors: [
      webAuthn({
        // `authUrl` targets the WebAuthn ceremony only; `auth: { url }` is also
        // read by the Provider as a SIWE-style auth capability (calls /challenge).
        authUrl: "/api/auth",
        testnet: true,
        name: "AcmeUSD Passkey Wallet",
      }),
    ],
    multiInjectedProviderDiscovery: false,
    transports: { [tempoModerato.id]: http() },
    ssr: true,
  });
}

export type WagmiConfig = ReturnType<typeof makeWagmiConfig>;

let singleton: WagmiConfig | undefined;
/** One config per browser tab: the provider, the API client and React all read the same active account. */
export function wagmiConfig(): WagmiConfig {
  if (!singleton) singleton = makeWagmiConfig();
  return singleton;
}

declare module "wagmi" {
  interface Register {
    config: WagmiConfig;
  }
}
