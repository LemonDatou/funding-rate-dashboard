import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const staticDir = new URL("web/", root);

test("page defaults to Binance and no longer exposes Gate", async () => {
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  assert.match(html, /value="binance" checked/);
  for (const exchange of ["okx", "bybit", "bitget", "hyperliquid"]) {
    assert.match(html, new RegExp(`value="${exchange}"`));
    assert.doesNotMatch(html, new RegExp(`value="${exchange}" checked`));
  }
  assert.doesNotMatch(html, /value="gate"|>Gate</);
  assert.match(html, /type="module" src="\.\/app\.js"/);
  assert.match(html, /id="toast"/);
  assert.match(html, />LemonDatou</);
  assert.match(html, /class="brand-link" href="\/margin-pool\/"/);
  assert.match(html, /Margin Pool ↗/);
  assert.match(html, /href="https:\/\/github\.com\/LemonDatou\/funding-rate-dashboard"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("frontend loads exchanges on demand without aggregate endpoints", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /loadExchange\("binance"\)/);
  assert.match(script, /await loadExchange\(exchange\)/);
  assert.match(script, /input\.disabled = true/);
  assert.match(script, /showToast\(/);
  assert.doesNotMatch(script, /\/api\/markets|\/api\/history/);
});

test("rates use four decimals and symmetric funding bounds use compact notation", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /percent\.toFixed\(4\)/);
  assert.match(script, /return `±\$\{formatRate\(Math\.abs\(cap\)\)\}`/);
});

test("Binance asset labels appear after the trading pair only", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /market\.exchange === "binance" && market\.asset_label/);
  assert.match(script, /`\$\{symbol\} \(\$\{market\.asset_label\}\)`/);
});

test("launcher only serves static files", async () => {
  const launcher = await readFile(new URL("run_dashboard.sh", root), "utf8");
  assert.match(launcher, /-m http\.server/);
  assert.doesNotMatch(launcher, /uvicorn|FastAPI/);
});
