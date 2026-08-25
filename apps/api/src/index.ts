import { app } from "@azure/functions";
import { API_ROUTES } from "@notification-cli/core/routes";

/**
 * The Azure Functions binding layer. Every route comes from the shared table,
 * so this host cannot drift from the App Service one.
 */
for (const route of API_ROUTES) {
  app.http(`${route.method}-${route.path.replace(/\//g, "-")}`, {
    methods: [route.method],
    authLevel: "anonymous",
    route: route.path,
    handler: (request, context) => route.handler(request, context),
  });
}
