import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const configuredRoot = process.env.BUZZ_PREVIEW_ROOT;
const socketPath = process.env.BUZZ_PREVIEW_SOCKET;
const allowedHost = process.env.BUZZ_PREVIEW_ALLOWED_HOST;
const proxyHost = process.env.BUZZ_PREVIEW_PROXY_HOST;

if (!configuredRoot || !socketPath || !allowedHost) {
  throw new Error("Preview root, socket, and allowed host are required.");
}
const root = realpathSync(resolve(configuredRoot));
const allowedHosts = new Set([allowedHost, proxyHost].filter(Boolean));

const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");
const inlineScriptHashes = [
  ...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
]
  .map((match) => match[1])
  .filter((script) => script.length > 0)
  .map(
    (script) =>
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
  );
const scriptPolicy = ["'self'", ...inlineScriptHashes].join(" ");

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": `default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function respond(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function requestHostname(request) {
  try {
    return new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    return "";
  }
}

const server = createServer((request, response) => {
  if (!allowedHosts.has(requestHostname(request))) {
    respond(response, 403, "Forbidden\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    respond(response, 405, "Method not allowed\n");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://preview.invalid").pathname,
    );
  } catch {
    respond(response, 400, "Bad request\n");
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${sep}`)) {
    respond(response, 404, "Not found\n");
    return;
  }

  let fileStat;
  let realFilePath;
  try {
    fileStat = statSync(filePath);
    realFilePath = realpathSync(filePath);
  } catch {
    respond(response, 404, "Not found\n");
    return;
  }
  if (!fileStat.isFile() || !realFilePath.startsWith(`${root}${sep}`)) {
    respond(response, 404, "Not found\n");
    return;
  }

  response.writeHead(200, {
    ...securityHeaders,
    "Content-Length": fileStat.size,
    "Content-Type":
      contentTypes.get(extname(realFilePath).toLowerCase()) ??
      "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(realFilePath).pipe(response);
});

rmSync(socketPath, { force: true });
server.listen(socketPath);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      rmSync(socketPath, { force: true });
      process.exit(0);
    });
  });
}
