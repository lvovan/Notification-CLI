import { WebPubSubServiceClient } from "@azure/web-pubsub";

export const HUB_NAME = "notifications";
export const CONNECTION_STRING_ENV =
  "NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING";

export function createWebPubSubClient(
  env: NodeJS.ProcessEnv = process.env,
): WebPubSubServiceClient {
  const connectionString = env[CONNECTION_STRING_ENV]?.trim();
  if (!connectionString) {
    throw new Error(`${CONNECTION_STRING_ENV} is not configured.`);
  }
  return new WebPubSubServiceClient(connectionString, HUB_NAME);
}
