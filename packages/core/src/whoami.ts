import type { CoreRequest, CoreResponse } from "./http.js";
import { resolveApiKeyOwner } from "./api-key.js";
import type { ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";

/** Lets the CLI verify a key, and name the account, before saving it. */
export async function handleWhoamiRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  keys?: ApiKeyStore | null,
): Promise<CoreResponse> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const resolution = await resolveApiKeyOwner(request, env, keys);
    if (!resolution.authorized) {
      return { status: 401, headers, jsonBody: { error: "Unauthorized" } };
    }
    return {
      status: 200,
      headers,
      jsonBody: { email: resolution.owner.email },
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { status: 503, headers, jsonBody: { error: error.message } };
    }
    throw error;
  }
}
