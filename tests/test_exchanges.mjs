import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCHANGES,
  binanceAlphaAssets,
  binanceAssetLabel,
  clearCachesForTests,
  fetchJson,
  fetchHistory,
  fetchMarginInterestHistory,
  fetchMarkets,
  fetchOpenInterest,
  marginPoolSearch,
  normalizedRates,
  resolveMarginPoolAsset,
} from "../web/exchanges.js";

const originalFetch = globalThis.fetch;
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});

function installFixtureFetch() {
  globalThis.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const body = options.body ? JSON.parse(options.body) : null;

    if (url.hostname === "fapi.binance.com") {
      if (url.pathname.endsWith("premiumIndex")) return json([{ symbol: "BTCUSDT", lastFundingRate: "0.0001", markPrice: "60000", nextFundingTime: 2_000_000_000_000, time: 1_999_000_000_000 }]);
      if (url.pathname.endsWith("fundingInfo")) return json([{ symbol: "BTCUSDT", fundingIntervalHours: 8, adjustedFundingRateCap: "0.02", adjustedFundingRateFloor: "-0.02" }]);
      if (url.pathname.endsWith("ticker/24hr")) return json([{ symbol: "BTCUSDT", lastPrice: "694.61", priceChangePercent: "10.99", quoteVolume: "2000000" }]);
      if (url.pathname.endsWith("exchangeInfo")) return json({ symbols: [{ symbol: "BTCUSDT", underlyingType: "COIN", underlyingSubType: ["PoW"] }] });
      if (url.pathname.endsWith("openInterest")) return json({ openInterest: "10" });
      if (url.pathname.endsWith("fundingRate")) return json([{ fundingTime: 1_999_000_000_000, fundingRate: "0.0001" }]);
    }

    if (url.hostname === "www.binance.com") {
      return json({ data: [{ symbol: "AVAAI", alphaId: "ALPHA_42", offline: false }] });
    }

    if (url.hostname === "www.okx.com") {
      if (url.pathname.endsWith("funding-rate-history")) return json({ data: [{ fundingTime: "1999000000000", realizedRate: "0.0001" }] });
      if (url.pathname.endsWith("funding-rate")) return json({ data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.0001", nextFundingRate: "0.0002", fundingTime: "2000000000000", nextFundingTime: "2000028800000", maxFundingRate: "0.003", minFundingRate: "-0.003", ts: "1999000000000" }] });
      if (url.pathname.endsWith("tickers")) return json({ data: [{ instId: "BTC-USDT-SWAP", last: "66000", open24h: "60000", volCcy24h: "20" }] });
      if (url.pathname.endsWith("open-interest")) return json({ data: [{ instId: "BTC-USDT-SWAP", oiUsd: "1000000" }] });
    }

    if (url.hostname === "api.bybit.com") {
      if (url.pathname.endsWith("instruments-info")) return json({ result: { list: [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", contractType: "LinearPerpetual", fundingInterval: 240, upperFundingRate: "0.004", lowerFundingRate: "-0.004" }] } });
      if (url.pathname.endsWith("tickers")) return json({ time: 1_999_000_000_000, result: { list: [{ symbol: "BTCUSDT", fundingRate: "0.0001", markPrice: "60000", lastPrice: "60600", price24hPcnt: "0.01", openInterestValue: "1000000", turnover24h: "2000000", nextFundingTime: "2000000000000" }] } });
      if (url.pathname.endsWith("funding/history")) return json({ result: { list: [{ fundingRateTimestamp: "1999000000000", fundingRate: "0.0001" }] } });
    }

    if (url.hostname === "api.bitget.com") {
      if (url.pathname.endsWith("instruments")) return json({ data: [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", fundInterval: "8" }] });
      if (url.pathname.endsWith("tickers")) return json({ requestTime: 1_999_000_000_000, data: [{ symbol: "BTCUSDT", fundingRate: "0.0001", markPrice: "60000", lastPrice: "58800", price24hPcnt: "-0.02", openInterest: "10", turnover24h: "2000000", ts: "1999000000000" }] });
      if (url.pathname.endsWith("current-fund-rate")) return json({ data: [{ symbol: "BTCUSDT", fundingRate: "0.0002", fundingRateInterval: "4", nextUpdate: "2000000000000", maxFundingRate: "0.005", minFundingRate: "-0.005" }] });
      if (url.pathname.endsWith("history-fund-rate")) return json({ data: { resultList: [{ fundingRateTimestamp: "1999000000000", fundingRate: "0.0001" }] } });
    }

    if (url.hostname === "api.hyperliquid.xyz") {
      if (body?.type === "perpDexs") return json([null]);
      if (body?.type === "fundingHistory") return json([{ time: 1_999_000_000_000, fundingRate: "0.0001" }]);
      if (body?.type === "metaAndAssetCtxs") return json([{ universe: [{ name: "BTC" }] }, [{ funding: "0.0001", markPx: "60000", midPx: "60000", prevDayPx: "50000", openInterest: "10", dayNtlVlm: "2000000" }]]);
    }

    throw new Error(`Unexpected request: ${url} ${JSON.stringify(body)}`);
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCachesForTests();
});

test("only the five CORS-capable exchanges are registered", () => {
  assert.deepEqual(EXCHANGES, ["binance", "okx", "bybit", "bitget", "hyperliquid"]);
  assert.equal(normalizedRates(0.0001, 4).rate_8h, 0.0002);
});

test("Binance asset labels use non-spot assets from the official Alpha list", () => {
  const alphaAssets = binanceAlphaAssets({
    data: [
      { symbol: "BTW", alphaId: "ALPHA_778", cexStates: 0 },
      { symbol: "AVAAI", alphaId: "ALPHA_42", cexStates: 0 },
      { symbol: "Cheems", cexCoinName: "1000CHEEMS", denomination: 1000, cexStates: 0 },
      { symbol: "SIREN", alphaId: "ALPHA_102", offline: true, cexStates: 0 },
      { symbol: "DELISTED_ALPHA", fullyDelisted: true, cexStates: 0 },
      { symbol: "SPOT", cexCoinName: "SPOT", cexStates: 1 },
    ],
  });
  assert.equal(alphaAssets.has("BTW"), true);
  assert.equal(alphaAssets.has("AVAAI"), true);
  assert.equal(alphaAssets.has("1000CHEEMS"), true);
  assert.equal(alphaAssets.has("SIREN"), true);
  assert.equal(alphaAssets.has("DELISTED_ALPHA"), true);
  assert.equal(alphaAssets.has("SPOT"), false);
  assert.equal(binanceAssetLabel({ underlyingType: "COIN", underlyingSubType: ["AI"] }, alphaAssets.has("AVAAI")), "Alpha");
  assert.equal(binanceAssetLabel({ underlyingType: "COIN", underlyingSubType: ["Alpha"] }, alphaAssets.has("MISSING")), null);
  assert.equal(binanceAssetLabel({ underlyingType: "COMMODITY" }, true), "大宗商品");
  assert.equal(binanceAssetLabel({ underlyingType: "EQUITY" }, true), "股票/ETF");
  assert.equal(binanceAssetLabel({ underlyingType: "HK_EQUITY" }), "港股");
  assert.equal(binanceAssetLabel({ underlyingType: "KR_EQUITY" }), "韩股");
  assert.equal(binanceAssetLabel({ underlyingType: "INDEX" }), "指数");
  assert.equal(binanceAssetLabel({ underlyingType: "PREMARKET", underlyingSubType: ["TradFi", "Pre-IPO"] }), "盘前");
});

test("only unlabelled Binance spot-like contracts link to normalized margin assets", () => {
  assert.deepEqual(marginPoolSearch({ exchange: "binance", base_asset: "BTC", asset_label: null }), { query: "BTC", contract: null });
  assert.deepEqual(marginPoolSearch({ exchange: "binance", base_asset: "1000BONK", asset_label: null }), { query: "BONK", contract: "1000BONK" });
  assert.deepEqual(marginPoolSearch({ exchange: "binance", base_asset: "1000000MOG", asset_label: null }), { query: "MOG", contract: "1000000MOG" });
  assert.deepEqual(marginPoolSearch({ exchange: "binance", base_asset: "1000X", asset_label: null }), { query: "X", contract: "1000X" });
  assert.deepEqual(marginPoolSearch({ exchange: "binance", base_asset: "龙虾", asset_label: null }), { query: "龙虾", contract: null });
  assert.equal(marginPoolSearch({ exchange: "binance", base_asset: "BTC", asset_label: "Alpha" }), null);
  assert.equal(marginPoolSearch({ exchange: "okx", base_asset: "BTC", asset_label: null }), null);

  const supported = new Set(["BTC", "BONK", "1000SATS"]);
  assert.equal(resolveMarginPoolAsset({ exchange: "binance", base_asset: "BTC", asset_label: null }, supported), "BTC");
  assert.equal(resolveMarginPoolAsset({ exchange: "binance", base_asset: "1000BONK", asset_label: null }, supported), "BONK");
  assert.equal(resolveMarginPoolAsset({ exchange: "binance", base_asset: "1000SATS", asset_label: null }, supported), "1000SATS");
  assert.equal(resolveMarginPoolAsset({ exchange: "binance", base_asset: "MISSING", asset_label: null }, supported), null);
});

test("HTTP client rejects non-official hosts and retries transient failures", async () => {
  await assert.rejects(() => fetchJson("https://example.com/data"), /非官方接口/);
  let calls = 0;
  let credentials;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    credentials = options.credentials;
    return calls === 1 ? json({ error: true }, 503) : json({ ok: true });
  };
  assert.deepEqual(await fetchJson("https://fapi.binance.com/fapi/v1/ping"), { ok: true });
  assert.equal(calls, 2);
  assert.equal(credentials, "omit");
});

test("Margin Pool interest history is loaded from the same-origin read-only API", async () => {
  let requestedUrl;
  globalThis.fetch = async (rawUrl, options) => {
    requestedUrl = String(rawUrl);
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    return json({
      points: [
        {
          timestamp_ms: 1_999_000_000_000,
          daily_interest_rate: "0.00331892",
          vip_level: 0,
        },
      ],
    });
  };
  const result = await fetchMarginInterestHistory("om", {
    fromMs: 1_998_000_000_000,
    toMs: 2_000_000_000_000,
  });
  assert.equal(
    requestedUrl,
    "/margin-pool/api/v1/assets/OM/interest-rates?from_ms=1998000000000&to_ms=2000000000000&max_points=400",
  );
  assert.deepEqual(result, {
    asset: "OM",
    points: [
      {
        timestamp: 1_999_000_000_000,
        daily_interest_rate: 0.00331892,
        vip_level: 0,
      },
    ],
  });
});

test("all five adapters map current markets and public history", async () => {
  installFixtureFetch();
  for (const exchange of EXCHANGES) {
    const progress = [];
    const markets = await fetchMarkets(exchange, { onProgress: (items) => progress.push(items) });
    assert.equal(markets.length, 1, `${exchange} current market`);
    assert.equal(markets[0].exchange, exchange);
    assert.ok(markets[0].funding_rate_8h !== null);
    assert.ok(markets[0].last_price !== null);
    assert.ok(markets[0].price_change_24h !== null);
    const history = await fetchHistory(exchange, markets[0].symbol, 2);
    assert.equal(history.exchange, exchange);
    assert.equal(history.points.length, 1, `${exchange} history`);
    if (exchange === "binance") {
      assert.ok(progress.length >= 2, "Binance should render before and after metadata enrichment");
      assert.equal(markets[0].last_price, 694.61);
      assert.equal(markets[0].price_change_24h, 0.1099);
      assert.equal(markets[0].open_interest_usd, null);
      assert.equal(await fetchOpenInterest("binance", markets[0].symbol, markets[0].mark_price), 600000);
    }
  }
});

test("Binance loads open interest only for the clicked symbol and caches it", async () => {
  let openInterestCalls = 0;
  const symbols = Array.from({ length: 20 }, (_, index) => `C${index}USDT`);
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.hostname === "www.binance.com") return json({ data: [] });
    if (url.pathname.endsWith("premiumIndex")) return json(symbols.map((symbol) => ({ symbol, lastFundingRate: "0.0001", markPrice: "10", nextFundingTime: 2_000_000_000_000 })));
    if (url.pathname.endsWith("fundingInfo")) return json([]);
    if (url.pathname.endsWith("ticker/24hr")) return json(symbols.map((symbol) => ({ symbol, quoteVolume: "2000000" })));
    if (url.pathname.endsWith("exchangeInfo")) return json({ symbols: symbols.map((symbol) => ({ symbol, underlyingType: "COIN", underlyingSubType: [] })) });
    if (url.pathname.endsWith("openInterest")) {
      openInterestCalls += 1;
      return json({ openInterest: "10" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const progress = [];
  const markets = await fetchMarkets("binance", { onProgress: (items) => progress.push(items) });
  assert.equal(markets.length, 20);
  assert.equal(openInterestCalls, 0);
  assert.ok(progress.length >= 2);
  assert.ok(markets.every((market) => market.open_interest_usd === null));
  assert.equal(await fetchOpenInterest("binance", markets[0].symbol, markets[0].mark_price), 100);
  assert.equal(await fetchOpenInterest("binance", markets[0].symbol, markets[0].mark_price), 100);
  assert.equal(openInterestCalls, 1);
});
