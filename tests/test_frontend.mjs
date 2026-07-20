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
  assert.match(html, /type="module" src="\.\/app\.js\?v=[^"]+"/);
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

  const appVersion = html.match(/src="\.\/app\.js\?v=([^"]+)"/)?.[1];
  const exchangeVersion = script.match(/from "\.\/exchanges\.js\?v=([^"]+)"/)?.[1];
  assert.ok(appVersion);
  assert.equal(exchangeVersion, appVersion);
});

test("latest price is followed by sortable spot and contract volume columns", async () => {
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  const spotVolumeHeading = html.indexOf('data-sort="spot_volume_24h_usd"');
  const contractVolumeHeading = html.indexOf('data-sort="volume_24h_usd"');
  const openInterestHeading = html.indexOf('data-sort="open_interest_usd"');
  const priceHeading = html.indexOf('data-sort="price_change_24h"');

  assert.ok(priceHeading > html.indexOf('data-sort="interval_hours"'));
  assert.ok(spotVolumeHeading > priceHeading);
  assert.ok(contractVolumeHeading > spotVolumeHeading);
  assert.ok(openInterestHeading > contractVolumeHeading);
  assert.match(html, /合约成交额 ≥/);
  assert.match(html, />现货成交额 <span>/);
  assert.match(html, />合约成交额 <span>/);
  assert.match(html, /colspan="10"/);
  assert.match(
    script,
    /intervalCell,\s*latestPriceCell\(market\),\s*cell\(formatMoney\(market\.spot_volume_24h_usd\), "numeric"\),\s*cell\(formatMoney\(market\.volume_24h_usd\), "numeric"\),\s*openInterestCell\(market\),/,
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

test("supported assets overlay borrow rates as negative costs on the funding history chart", async () => {
  const html = await readFile(new URL("index.html", staticDir), "utf8");
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  const styles = await readFile(new URL("styles.css", staticDir), "utf8");
  assert.match(html, /id="borrow-legend"/);
  assert.match(html, /id="chart-guide"/);
  assert.match(html, /历史资金费率与借款成本曲线/);
  assert.match(script, /fetchMarginInterestHistory\(poolAsset/);
  assert.match(script, /state\.unit === "1y" \? dailyRate \* 365 : dailyRate \/ 3/);
  assert.match(script, /value: rawValue === null \? null : -rawValue/);
  assert.match(script, /drawSeries\(borrowPoints, colors\.borrow, \{ stepped: true \}\)/);
  assert.match(script, /`资金费率 \$\{formatRate\(fundingNearest\?\.value\)\}`/);
  assert.match(script, /`借款成本 \$\{formatRate\(borrowNearest\.rawValue\)\}`/);
  assert.doesNotMatch(script, /`原始利率 /);
  assert.match(script, /top: 18,[\s\S]*right: Math\.min\(116, Math\.max\(64, width \* 0\.2\)\)[\s\S]*left: 76/);
  assert.match(script, /tooltip\.style\.left = `\$\{guideLeft\}px`/);
  assert.match(script, /chartGuide\.style\.left = `\$\{guideLeft\}px`/);
  assert.match(script, /const xTickCount = Math\.max\(3, Math\.min\(6, Math\.floor\(plotWidth \/ 120\) \+ 1\)\)/);
  assert.match(script, /context\.fillText\(formatAxisDate\(time\), x, height - 23\)/);
  assert.doesNotMatch(script, /context\.fillText\(formatTimestamp\(fundingPoints/);
  assert.doesNotMatch(script, /tooltip\.style\.top/);
  assert.match(html, /借款成本（负值）/);
  assert.match(html, /并作为成本以负值绘制/);
  assert.match(styles, /--borrow:/);
  assert.match(styles, /\.chart-guide \{[^}]*bottom: 34px;[^}]*border-left: 1px dashed var\(--line\);/s);
  assert.match(styles, /\.chart-tooltip \{[^}]*position: absolute;[^}]*bottom: 100%;/s);
  assert.match(styles, /transform: translateX\(-50%\)/);
  assert.match(styles, /overflow-x: hidden;/);
  assert.match(styles, /width: max-content;/);
  assert.match(styles, /white-space: pre;/);
  assert.doesNotMatch(styles, /overflow-wrap: anywhere;/);
});

test("history stats label and calculate the average over the latest seven days", async () => {
  const script = await readFile(new URL("app.js", staticDir), "utf8");
  assert.match(script, /latestHistoryTime - 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(script, /item\.time > sevenDaysAgo/);
  assert.match(script, /\["近7日平均", formatRate\(average\)\]/);
  assert.doesNotMatch(script, /\["平均", formatRate\(average\)\]/);
});

test("launcher only serves static files", async () => {
  const launcher = await readFile(new URL("run_dashboard.sh", root), "utf8");
  const nginx = await readFile(new URL("deploy/nginx-funding-rate-dashboard.conf", root), "utf8");
  assert.match(launcher, /-m http\.server/);
  assert.doesNotMatch(launcher, /uvicorn|FastAPI/);
  assert.match(nginx, /connect-src 'self' https:\/\/fapi\.binance\.com/);
  assert.match(nginx, /https:\/\/www\.binance\.com/);
  assert.match(nginx, /https:\/\/data-api\.binance\.vision/);
  assert.match(nginx, /Cache-Control "no-cache, must-revalidate"/);
});
