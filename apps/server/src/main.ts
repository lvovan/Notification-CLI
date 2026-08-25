import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createEntraSessionProvider, readEntraConfig } from "./entra.js";
import { lazySessionProvider } from "./session.js";
import { createNotificationServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(process.env.NOTIFICATION_CLI_WEB_ROOT ?? resolve(here, "../web"));
const port = Number(process.env.PORT ?? 8080);

const server = createNotificationServer({
  webRoot,
  session: lazySessionProvider(() => createEntraSessionProvider(readEntraConfig())),
});

server.listen(port, () => {
  console.log(`Notification CLI listening on ${port}, serving ${webRoot}`);
});
