import type { ServerHost } from "@/types/server";

/** Secret credential fields that may exist on stored server records but must never leave the server. */
export const SERVER_SECRET_FIELDS = ["password", "privateKey", "passphrase"] as const;

/** A stored server record, which at runtime may carry secret credential fields. */
export type StoredServer = ServerHost & {
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

/** Server shape safe to return from API responses: secrets removed, presence flags added. */
export type PublicServer = Omit<ServerHost, "password" | "privateKey" | "passphrase"> & {
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
};

function isPresent(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Pure: returns a copy of the server without secret fields, plus booleans indicating which secrets are stored. */
export function toPublicServer(server: StoredServer): PublicServer {
  const { password, privateKey, passphrase, ...rest } = server;
  return {
    ...rest,
    hasPassword: isPresent(password),
    hasPrivateKey: isPresent(privateKey),
    hasPassphrase: isPresent(passphrase),
  };
}

export function toPublicServers(servers: readonly StoredServer[]): PublicServer[] {
  return servers.map(toPublicServer);
}
