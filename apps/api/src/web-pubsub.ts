import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { requireSetting } from "./configuration.js";

export const HUB_NAME = "notifications";
export const CONNECTION_STRING_ENV =
  "NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING";

export function createWebPubSubClient(
  env: NodeJS.ProcessEnv = process.env,
): WebPubSubServiceClient {
  return new WebPubSubServiceClient(
    requireSetting(env, CONNECTION_STRING_ENV),
    HUB_NAME,
  );
}
