import type { CoreRequest, CoreResponse } from "./http.js";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import {
  maskApiKey,
  tryCreateApiKeyStore,
  type ApiKeyRecord,
  type ApiKeyStore,
} from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import { STORAGE_CONNECTION_STRING_ENV } from "./table-storage.js";

const NO_STORE = { "Cache-Control": "no-store" };

function keyResponse(record: ApiKeyRecord): CoreResponse {
  return {
    status: 200,
    headers: NO_STORE,
    jsonBody: { apiKey: record.apiKey, maskedKey: maskApiKey(record.apiKey) },
  };
}

function storageUnavailable(): CoreResponse {
  return {
    status: 503,
    headers: NO_STORE,
    jsonBody: {
      error: `${STORAGE_CONNECTION_STRING_ENV} is not configured.`,
    },
  };
}

async function withKeyStore(
  request: CoreRequest,
  env: NodeJS.ProcessEnv,
  store: ApiKeyStore | null | undefined,
  action: (keys: ApiKeyStore, email: string) => Promise<ApiKeyRecord>,
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const keys = store === undefined ? tryCreateApiKeyStore(env) : store;
  if (!keys) {
    return storageUnavailable();
  }

  try {
    return keyResponse(await action(keys, authorization.email));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { status: 503, headers: NO_STORE, jsonBody: { error: error.message } };
    }
    throw error;
  }
}

/** Mints the caller's key on first visit, then returns the same key. */
export function handleApiKeyRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: ApiKeyStore | null,
): Promise<CoreResponse> {
  return withKeyStore(request, env, store, (keys, email) => keys.ensure(email));
}

export function handleApiKeyCycleRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: ApiKeyStore | null,
): Promise<CoreResponse> {
  return withKeyStore(request, env, store, (keys, email) => keys.cycle(email));
}
