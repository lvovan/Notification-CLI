/**
 * The identity the server presents to Azure Storage and Web PubSub.
 *
 * Nothing here holds a key. On App Service the credential resolves to the
 * site's system-assigned managed identity, whose role assignments are declared
 * in `infra/main.bicep`; running locally it falls back to whoever is signed in
 * to the Azure CLI, so development needs no secret either.
 *
 * The credential is created once and shared, because each instance keeps its
 * own token cache: building one per client would fetch a fresh token for every
 * table and every send.
 */

import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

let shared: TokenCredential | undefined;

export function azureCredential(): TokenCredential {
  shared ??= new DefaultAzureCredential();
  return shared;
}
