import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "static-preview-server.mjs",
);
const ALLOWED_HOST = "preview.example.test";

function unixRequest({
  host = ALLOWED_HOST,
  method = "GET",
  path = "/",
  socketPath,
}) {
  return new Promise((resolve, reject) => {
    const requestHandle = request(
      { headers: { host }, method, path, socketPath },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    requestHandle.on("error", reject);
    requestHandle.end();
  });
}

async function waitForSocket(socketPath, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socketPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`Preview server exited early: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Preview socket was not created: ${stderr()}`);
}

test("static preview server is host-locked, read-only, and contained", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "buzz-preview-test-"));
  const distRoot = join(fixtureRoot, "dist");
  const socketPath = join(fixtureRoot, "preview.sock");
  const inlineScript = "document.documentElement.dataset.preview = 'ready';";
  mkdirSync(distRoot);
  writeFileSync(
    join(distRoot, "index.html"),
    `<html><head><script>${inlineScript}</script></head><body>preview</body></html>`,
  );
  writeFileSync(join(distRoot, "asset.js"), "export const ready = true;");
  writeFileSync(join(fixtureRoot, "secret.txt"), "must not be served");
  symlinkSync(join(fixtureRoot, "secret.txt"), join(distRoot, "escape.txt"));

  let stderr = "";
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      BUZZ_PREVIEW_ALLOWED_HOST: ALLOWED_HOST,
      BUZZ_PREVIEW_ROOT: distRoot,
      BUZZ_PREVIEW_SOCKET: socketPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitForSocket(socketPath, child, () => stderr);

    const home = await unixRequest({ socketPath });
    assert.equal(home.status, 200);
    assert.equal(home.body.includes("preview"), true);
    assert.equal(home.headers["cache-control"], "no-store");
    assert.equal(home.headers["x-frame-options"], "DENY");
    const expectedHash = createHash("sha256")
      .update(inlineScript)
      .digest("base64");
    assert.equal(
      home.headers["content-security-policy"].includes(
        `script-src 'self' 'sha256-${expectedHash}'`,
      ),
      true,
    );

    assert.equal(
      (await unixRequest({ host: "evil.example", socketPath })).status,
      403,
    );
    assert.equal(
      (await unixRequest({ method: "POST", socketPath })).status,
      405,
    );
    assert.equal(
      (await unixRequest({ path: "/%2e%2e%2fsecret.txt", socketPath })).status,
      404,
    );
    assert.equal(
      (await unixRequest({ path: "/escape.txt", socketPath })).status,
      404,
    );
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
