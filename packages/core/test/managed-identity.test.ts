import assert from "node:assert/strict";
import test from "node:test";
import { azureCredential } from "@notification-cli/core/azure-credential";
import {
  STORAGE_TABLE_ENDPOINT_ENV,
  createTableClient,
} from "@notification-cli/core/table-storage";
import {
  ENDPOINT_ENV,
  HUB_NAME,
  createWebPubSubClient,
} from "@notification-cli/core/web-pubsub";

const tableEndpoint = "https://example.table.core.windows.net/";
const webPubSubEndpoint = "https://example.webpubsub.azure.com";

test("the table client is built from an endpoint and a credential", () => {
  const client = createTableClient(
    { [STORAGE_TABLE_ENDPOINT_ENV]: tableEndpoint },
    "ApiKeys",
  );

  assert.equal(client.url, tableEndpoint);
  assert.equal(client.tableName, "ApiKeys");
});

test("the Web PubSub client is built from an endpoint and a credential", () => {
  const client = createWebPubSubClient({ [ENDPOINT_ENV]: webPubSubEndpoint });

  assert.equal(client.endpoint, webPubSubEndpoint);
  assert.equal(client.hubName, HUB_NAME);
});

test("a connection string is no longer an accepted setting value", () => {
  // Both clients used to be built from a connection string carrying an account
  // key. Nothing mints those any more, and a leftover one has to fail loudly
  // rather than be parsed as a URL and quietly point at nothing.
  assert.throws(() =>
    createTableClient(
      {
        [STORAGE_TABLE_ENDPOINT_ENV]:
          "DefaultEndpointsProtocol=https;AccountName=example;AccountKey=key;EndpointSuffix=core.windows.net",
      },
      "ApiKeys",
    ),
  );
});

test("one credential is shared, so its token cache is shared", () => {
  // A credential per client would fetch a fresh token for every table and
  // every send, since each instance caches separately.
  assert.equal(azureCredential(), azureCredential());
});
