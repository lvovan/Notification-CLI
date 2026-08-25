import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { resolveApiKeyOwner } from "./api-key.js";
import type { ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";

/** Lets the CLI verify a key, and name the account, before saving it. */
export async function handleWhoamiRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  keys?: ApiKeyStore | null,
): Promise<HttpResponseInit> {
  const headers = { "Cache-Control": "no-store" };
  try {
    const resolution = await resolveApiKeyOwner(request, env, keys);
    if (!resolution.authorized) {
      return { status: 401, headers, jsonBody: { error: "Unauthorized" } };
    }
    return {
      status: 200,
      headers,
      jsonBody: {
        email: resolution.owner.email,
        // TEMPORARY DIAGNOSTIC: confirms which headers survive the Static Web
        // Apps proxy. Remove once the bearer-token question is settled.
        diagnostic: {
          names: [...request.headers.keys()].sort(),
          authorization: request.headers.get("authorization")?.slice(0, 24),
        },
      },
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { status: 503, headers, jsonBody: { error: error.message } };
    }
    throw error;
  }
}
