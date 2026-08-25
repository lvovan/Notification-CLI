import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendBuffer } from "./response.js";

const HTML = "text/html; charset=utf-8";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": HTML,
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Files the browser must re-validate on every load. Everything else served
 * from `dist` carries a content hash in its name, so it can be cached forever.
 */
const REVALIDATE = new Set(["/index.html", "/service-worker.js", "/manifest.webmanifest"]);

/**
 * Extensions excluded from the single-page fallback, matching the Static Web
 * App's `navigationFallback.exclude`: a missing asset must 404 rather than
 * quietly return the application shell.
 */
const ASSET = /\.(css|ico|js|json|png|svg|webmanifest)$/;

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

function cacheControl(path: string): string {
  return REVALIDATE.has(path) ? "no-cache" : "public, max-age=31536000, immutable";
}

/** Resolves a URL path inside the web root, or null if it escapes it. */
function locate(root: string, pathname: string): string | null {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const absolute = resolve(root, relative);
  return absolute === root || absolute.startsWith(root + sep) ? absolute : null;
}

async function read(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Serves the built PWA, falling back to the application shell for routes. */
export async function serveStatic(
  response: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const absolute = locate(root, requested);
  const found = absolute === null ? null : await read(absolute);
  if (found) {
    sendBuffer(response, 200, found, {
      "Content-Type": contentType(requested),
      "Cache-Control": cacheControl(requested),
    });
    return;
  }

  if (ASSET.test(requested)) {
    sendBuffer(response, 404, Buffer.from("Not found"), {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return;
  }

  const shell = await read(join(root, "index.html"));
  if (!shell) {
    sendBuffer(response, 500, Buffer.from("Application shell is missing"), {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return;
  }
  sendBuffer(response, 200, shell, {
    "Content-Type": HTML,
    "Cache-Control": "no-cache",
  });
}
