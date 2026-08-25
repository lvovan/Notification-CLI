import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { requireSetting } from "./configuration.js";
import { userGroup } from "./identity.js";

export const HUB_NAME = "notifications";
export const CONNECTION_STRING_ENV =
  "NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING";
/** Minutes a browser's client access token stays valid. */
export const CLIENT_TOKEN_MINUTES = 60;

export interface NotificationGroupSender {
  group(groupName: string): {
    sendToAll(message: object): Promise<unknown>;
  };
}

export interface NotificationNegotiator {
  getClientAccessToken(options: {
    expirationTimeInMinutes: number;
    groups: string[];
  }): Promise<{ url: string }>;
}

export function createWebPubSubClient(
  env: NodeJS.ProcessEnv = process.env,
): WebPubSubServiceClient {
  return new WebPubSubServiceClient(
    requireSetting(env, CONNECTION_STRING_ENV),
    HUB_NAME,
  );
}

/**
 * The SDK's sendToAll is overloaded with a text-first signature, which does not
 * structurally satisfy the JSON-only shape the fan-out depends on, so the JSON
 * overload is selected explicitly here. An object payload is serialized as JSON
 * by the SDK, so no content type has to be requested.
 */
export function groupSender(
  client: WebPubSubServiceClient,
): NotificationGroupSender {
  return {
    group: (groupName) => {
      const group = client.group(groupName);
      return {
        sendToAll: (message) => group.sendToAll(message),
      };
    },
  };
}

export function createNotificationSender(
  env: NodeJS.ProcessEnv = process.env,
): NotificationGroupSender {
  return groupSender(createWebPubSubClient(env));
}

/**
 * Issues a token bound to the caller's own group. No roles are granted, so the
 * connection cannot join or leave any other group, nor publish: the group it is
 * auto-joined to on connect is the only traffic it will ever receive.
 */
export function issueClientAccessToken(
  negotiator: NotificationNegotiator,
  email: string,
): Promise<{ url: string }> {
  return negotiator.getClientAccessToken({
    expirationTimeInMinutes: CLIENT_TOKEN_MINUTES,
    groups: [userGroup(email)],
  });
}

export function sendToUserGroup(
  sender: NotificationGroupSender,
  email: string,
  message: object,
): Promise<unknown> {
  return sender.group(userGroup(email)).sendToAll(message);
}
