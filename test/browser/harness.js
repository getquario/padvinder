import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const built = (await readFile(new URL("../../lib/index.js", import.meta.url), "utf8"))
  .replace(/from\s*["']treffer["']/g, 'from"/treffer.js"')
  .replace(/from\s*["']waarmerk["']/g, 'from"/waarmerk.js"');

// Treffer imports waarmerk too, so the dependency it is served as needs the same
// rewrite before the browser sees it.
const dependency = async (name) =>
  (await readFile(new URL(import.meta.resolve(name)), "utf8")).replace(
    /from\s*["']waarmerk["']/g,
    'from"/waarmerk.js"',
  );
const files = new Map([
  ["/", ["text/html; charset=utf-8", await readFile(new URL("./index.html", import.meta.url))]],
  [
    "/browser.js",
    ["text/javascript; charset=utf-8", await readFile(new URL("./browser.js", import.meta.url))],
  ],
  ["/lib/index.js", ["text/javascript; charset=utf-8", built]],
  // Resolved through the exports map rather than a hardcoded path, so this
  // keeps working whichever directory treffer publishes its entry from.
  ["/treffer.js", ["text/javascript; charset=utf-8", await dependency("treffer")]],
  ["/waarmerk.js", ["text/javascript; charset=utf-8", await dependency("waarmerk")]],
]);

const server = http.createServer((request, response) => {
  const file = files.get(new URL(request.url, "http://localhost").pathname);
  if (!file) {
    response.writeHead(404).end("Not found");
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": file[0],
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    })
    .end(file[1]);
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${port}`);
  const done = page.locator('#result[data-status="passed"], #result[data-status="failed"]');
  await done.waitFor({ timeout: 10_000 });
  const status = await done.getAttribute("data-status");
  const message = await done.textContent();

  assert.equal(status, "passed", message);
  assert.deepEqual(browserErrors, []);
  console.log("Browser CSP test passed");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
