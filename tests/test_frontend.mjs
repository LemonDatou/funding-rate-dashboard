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
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.doesNotMatch(html, /id="oi-filter"|id="oi-value"/);
  assert.match(html, /data-sort="open_interest_usd"/);
  assert.match(script, /fetchOpenInterest/);
  assert.match(script, /function openInterestCell\(market\)/);
  assert.match(script, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(script, /minOpenInterest|oiInput/);
  assert.match(script, /loadExchange\("binance"\)/);
  assert.match(script, /await loadExchange\(exchange\)/);
  assert.match(script, /input\.disabled = true/);
  assert.match(script, /showToast\(/);
  assert.doesNotMatch(script, /\/api\/markets|\/api\/history/);
});

test("latest price sorts by 24h change before the final activity columns", async () => {
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  const volumeHeading = html.indexOf('data-sort="volume_24h_usd"');
  const openInterestHeading = html.indexOf('data-sort="open_interest_usd"');
  const priceHeading = html.indexOf('data-sort="price_change_24h"');

  assert.ok(priceHeading > html.indexOf('data-sort="interval_hours"'));
  assert.ok(volumeHeading > priceHeading);
  assert.ok(openInterestHeading > volumeHeading);
  assert.match(
    script,
    /intervalCell,\s*latestPriceCell\(market\),\s*cell\(formatMoney\(market\.volume_24h_usd\), "numeric"\),\s*openInterestCell\(market\),/,
  );
  assert.match(script, /formatPrice\(market\.last_price\).*formatPriceChange\(market\.price_change_24h\)/s);
  assert.match(script, /number\.toExponential\(3\)/);
});

test("rates use four decimals and symmetric funding bounds use compact notation", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /percent\.toFixed\(4\)/);
  assert.match(script, /return `±\$\{formatRate\(Math\.abs\(cap\)\)\}`/);
});

test("positive rates are green and negative rates are red in both themes", async () => {
  const styles = await readFile(new URL("styles.css", staticDir), "utf8");
  assert.match(styles, /:root \{[^}]*--positive: #15803d;[^}]*--negative: #dc2626;/s);
  assert.match(styles, /:root\[data-theme="dark"\] \{[^}]*--positive: #4ade80;[^}]*--negative: #f87171;/s);
  assert.match(styles, /\.rate-positive \{ color: var\(--positive\); \}/);
  assert.match(styles, /\.rate-negative \{ color: var\(--negative\); \}/);
});

test("Binance asset labels appear after the trading pair only", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /market\.exchange === "binance" && market\.asset_label/);
  assert.match(script, /`\$\{symbol\} \(\$\{market\.asset_label\}\)`/);
});

test("supported Binance symbols link directly to Margin Pool assets", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  const styles = await readFile(new URL("styles.css", staticDir), "utf8");
  assert.match(script, /fetch\("\/margin-pool\/api\/v1\/pools"/);
  assert.match(script, /const poolAsset = resolveMarginPoolAsset\(market, state\.marginPoolAssets\)/);
  assert.match(script, /symbolControl\.href = `\/margin-pool\/assets\/\$\{encodeURIComponent\(poolAsset\)\}`/);
  assert.match(script, /symbolControl\.addEventListener\("click", \(event\) => event\.stopPropagation\(\)\)/);
  assert.doesNotMatch(styles, /\.symbol-button:hover/);
  assert.match(styles, /\.margin-pool-link:hover/);
});

test("supported assets overlay borrow rates on the funding history chart", async () => {
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  const styles = await readFile(new URL("styles.css", staticDir), "utf8");
  assert.match(html, /id="borrow-legend"/);
  assert.match(html, /历史资金费率与借款利率曲线/);
  assert.match(script, /fetchMarginInterestHistory\(poolAsset/);
  assert.match(script, /state\.unit === "1y" \? dailyRate \* 365 : dailyRate \/ 3/);
  assert.match(script, /drawSeries\(borrowPoints, colors\.borrow, \{ stepped: true \}\)/);
  assert.match(script, /`资金费率 \$\{formatRate\(fundingNearest\?\.value\)\}`/);
  assert.match(script, /`借款利率 \$\{formatRate\(borrowNearest\.value\)\}`/);
  assert.match(styles, /--borrow:/);
  assert.match(styles, /white-space: pre;/);
});

test("launcher only serves static files", async () => {
  const launcher = await readFile(new URL("run_dashboard.sh", root), "utf8");
  const nginx = await readFile(new URL("deploy/nginx-funding-rate-dashboard.conf", root), "utf8");
  assert.match(launcher, /-m http\.server/);
  assert.doesNotMatch(launcher, /uvicorn|FastAPI/);
  assert.match(nginx, /connect-src 'self' https:\/\/fapi\.binance\.com/);
});
