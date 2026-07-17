export const EXCHANGES = Object.freeze([
  "binance",
  "okx",
  "bybit",
  "bitget",
  "hyperliquid",
]);

export const EXCHANGE_LABELS = Object.freeze({
  binance: "Binance",
  okx: "OKX",
  bybit: "Bybit",
  bitget: "Bitget",
  hyperliquid: "Hyperliquid",
});

const BINANCE_CONTRACT_MULTIPLIER = /^(?:1000000|1000)(?=.+$)/;

export function marginPoolSearch(market) {
  if (!market || market.exchange !== "binance" || market.asset_label) return null;
  const baseAsset = String(market.base_asset || "").split(":").pop().trim().toUpperCase();
  if (!baseAsset || baseAsset.length > 64 || /[\u0000-\u001f\u007f]/.test(baseAsset)) return null;
  const query = baseAsset.replace(BINANCE_CONTRACT_MULTIPLIER, "") || baseAsset;
  return { query, contract: query === baseAsset ? null : baseAsset };
}

const ALLOWED_HOSTS = new Set([
  "fapi.binance.com",
  "www.okx.com",
  "api.bybit.com",
  "api.bitget.com",
  "api.hyperliquid.xyz",
]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MARKET_CACHE_MS = 30_000;
const OPEN_INTEREST_CACHE_MS = 120_000;
const BINANCE_METADATA_CACHE_MS = 10 * 60_000;
const marketCache = new Map();
const binanceOpenInterestCache = new Map();
let binanceMetadataCache = null;

const BINANCE_ASSET_LABELS = Object.freeze({
  COMMODITY: "大宗商品",
  EQUITY: "股票/ETF",
  HK_EQUITY: "港股",
  KR_EQUITY: "韩股",
  INDEX: "指数",
  PREMARKET: "盘前",
});

export class ExchangeError extends Error {}

export function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizedRates(rate, intervalHours) {
  const parsedRate = finite(rate);
  const parsedInterval = finite(intervalHours);
  if (parsedRate === null) throw new ExchangeError("资金费率不是有效数字");
  const interval = parsedInterval !== null && parsedInterval > 0 ? parsedInterval : 8;
  const rate8h = parsedRate * 8 / interval;
  return { rate: parsedRate, rate_8h: rate8h, rate_1y: rate8h * 3 * 365 };
}

function timestampIso(value, seconds = false) {
  const number = finite(value);
  if (number === null || number <= 0) return null;
  const milliseconds = seconds || number < 10_000_000_000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rows(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
}

function dataRows(payload) {
  return payload && typeof payload === "object" ? rows(payload.data) : [];
}

function resultRows(payload) {
  return payload?.result && typeof payload.result === "object" ? rows(payload.result.list) : [];
}

function positiveProduct(...values) {
  const parsed = values.map(finite);
  if (parsed.some((value) => value === null)) return null;
  return Math.abs(parsed.reduce((product, value) => product * value, 1));
}

function relativePriceChange(current, previous) {
  const currentPrice = finite(current);
  const previousPrice = finite(previous);
  if (currentPrice === null || previousPrice === null || previousPrice === 0) return null;
  return (currentPrice - previousPrice) / previousPrice;
}

export function binanceAssetLabel(metadata) {
  const type = String(metadata?.underlyingType || "");
  const subtypes = Array.isArray(metadata?.underlyingSubType) ? metadata.underlyingSubType : [];
  if (type === "COIN") return subtypes.includes("Alpha") ? "Alpha" : null;
  return BINANCE_ASSET_LABELS[type] || null;
}

async function fetchBinanceMetadata(base, signal) {
  if (binanceMetadataCache?.expiresAt > Date.now()) return binanceMetadataCache.symbols;
  const payload = await fetchJson(`${base}/fapi/v1/exchangeInfo`, {
    signal,
    timeoutMs: 15_000,
    attempts: 1,
  });
  const symbols = new Map(rows(payload?.symbols).map((row) => [String(row.symbol || ""), row]));
  binanceMetadataCache = { symbols, expiresAt: Date.now() + BINANCE_METADATA_CACHE_MS };
  return symbols;
}

function futureBoundaryMs(intervalHours) {
  const interval = Math.max(1, Math.round(intervalHours * 3_600_000));
  return (Math.floor(Date.now() / interval) + 1) * interval;
}

function createAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function retryDelay(response, attempt) {
  const retryAfter = finite(response?.headers?.get?.("retry-after"));
  return retryAfter !== null ? Math.min(5_000, retryAfter * 1000) : 200 * (2 ** attempt);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
    }, { once: true });
  });
}

export async function fetchJson(url, {
  params,
  method = "GET",
  body,
  signal,
  timeoutMs = 8_000,
  attempts = 2,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    throw new ExchangeError(`拒绝访问非官方接口：${target.hostname}`);
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== "") target.searchParams.set(key, String(value));
  }

  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const requestSignal = createAbortSignal(signal, timeoutMs);
    try {
      const response = await fetch(target, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        signal: requestSignal.signal,
      });
      if (!response.ok) {
        const error = new ExchangeError(`HTTP ${response.status}`);
        if (!RETRYABLE_STATUS.has(response.status) || attempt + 1 >= attempts) throw error;
        lastError = error;
        requestSignal.cleanup();
        await wait(retryDelay(response, attempt), signal);
        continue;
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("请求已取消", "AbortError");
      lastError = error;
      if (attempt + 1 >= attempts || (error instanceof ExchangeError && !String(error.message).startsWith("HTTP 5") && !String(error.message).startsWith("HTTP 429") && !String(error.message).startsWith("HTTP 408") && !String(error.message).startsWith("HTTP 425"))) {
        throw error;
      }
      await wait(200 * (2 ** attempt), signal);
    } finally {
      requestSignal.cleanup();
    }
  }
  throw lastError ?? new ExchangeError("公开接口请求失败");
}

function makeMarket(exchange, {
  symbol,
  baseAsset,
  quoteAsset,
  rate,
  intervalHours,
  markPrice = null,
  lastPrice = null,
  priceChange24h = null,
  openInterestUsd = null,
  volume24hUsd = null,
  nextFundingTime = null,
  updatedAt = null,
  nextFundingRate = null,
  fundingCap = null,
  fundingFloor = null,
  assetLabel = null,
  timestampSeconds = false,
}) {
  const parsedInterval = finite(intervalHours);
  const interval = parsedInterval !== null && parsedInterval > 0 ? parsedInterval : 8;
  const normalized = normalizedRates(rate, interval);
  return {
    exchange,
    exchange_label: EXCHANGE_LABELS[exchange],
    symbol,
    base_asset: baseAsset,
    quote_asset: quoteAsset,
    funding_rate: normalized.rate,
    interval_hours: interval,
    funding_rate_8h: normalized.rate_8h,
    funding_rate_1y: normalized.rate_1y,
    mark_price: finite(markPrice),
    last_price: finite(lastPrice) ?? finite(markPrice),
    price_change_24h: finite(priceChange24h),
    open_interest_usd: finite(openInterestUsd),
    volume_24h_usd: finite(volume24hUsd),
    next_funding_time: typeof nextFundingTime === "string" && nextFundingTime.endsWith("Z")
      ? nextFundingTime
      : timestampIso(nextFundingTime, timestampSeconds),
    updated_at: typeof updatedAt === "string" && updatedAt.endsWith("Z")
      ? updatedAt
      : timestampIso(updatedAt, timestampSeconds) || new Date().toISOString(),
    next_funding_rate: finite(nextFundingRate),
    funding_cap: finite(fundingCap),
    funding_floor: finite(fundingFloor),
    asset_label: assetLabel,
    stale: false,
  };
}

function historyResult(exchange, symbol, intervalHours, pairs, limit) {
  const unique = new Map();
  for (const [rawTimestamp, rawRate, seconds = false] of pairs) {
    const timestamp = timestampIso(rawTimestamp, seconds);
    if (!timestamp) continue;
    try {
      const normalized = normalizedRates(rawRate, intervalHours);
      unique.set(timestamp, { timestamp, ...normalized });
    } catch (_) {
      // Ignore malformed exchange rows without losing the rest of the history.
    }
  }
  const points = [...unique.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-limit);
  return { exchange, symbol, interval_hours: intervalHours, points };
}

async function fetchBinanceMarkets({ signal, onProgress }) {
  const base = "https://fapi.binance.com";
  const metadataPromise = fetchBinanceMetadata(base, signal).catch(() => new Map());
  const [premium, fundingInfo, tickerPayload] = await Promise.all([
    fetchJson(`${base}/fapi/v1/premiumIndex`, { signal }),
    fetchJson(`${base}/fapi/v1/fundingInfo`, { signal }).catch(() => []),
    fetchJson(`${base}/fapi/v1/ticker/24hr`, { signal }).catch(() => []),
  ]);
  const premiumRows = rows(premium);
  if (!premiumRows.length) throw new ExchangeError("Binance 未返回资金费率市场");
  const info = new Map(rows(fundingInfo).map((row) => [String(row.symbol || ""), row]));
  const tickers = new Map(rows(tickerPayload).map((row) => [String(row.symbol || ""), row]));
  const now = Date.now();
  const markets = [];
  for (const row of premiumRows) {
    const symbol = String(row.symbol || "");
    if (!symbol.endsWith("USDT") || symbol.includes("_")) continue;
    const details = info.get(symbol) || {};
    const ticker = tickers.get(symbol) || {};
    const cachedOi = binanceOpenInterestCache.get(symbol);
    try {
      markets.push(makeMarket("binance", {
        symbol,
        baseAsset: symbol.slice(0, -4),
        quoteAsset: "USDT",
        rate: row.lastFundingRate,
        intervalHours: finite(details.fundingIntervalHours) || 8,
        markPrice: row.markPrice,
        lastPrice: finite(ticker.lastPrice) ?? row.markPrice,
        priceChange24h: finite(ticker.priceChangePercent) === null ? null : finite(ticker.priceChangePercent) / 100,
        openInterestUsd: cachedOi?.expiresAt > now ? cachedOi.value : null,
        volume24hUsd: ticker.quoteVolume,
        nextFundingTime: row.nextFundingTime,
        updatedAt: row.time,
        fundingCap: details.adjustedFundingRateCap,
        fundingFloor: details.adjustedFundingRateFloor,
        assetLabel: null,
      }));
    } catch (_) {
      // Skip malformed symbols.
    }
  }
  markets.sort((left, right) => left.symbol.localeCompare(right.symbol));
  onProgress?.(markets.map((market) => ({ ...market })));

  const enrichMetadata = metadataPromise.then((metadata) => {
    for (const market of markets) market.asset_label = binanceAssetLabel(metadata.get(market.symbol));
    onProgress?.(markets.map((market) => ({ ...market })));
  });
  await enrichMetadata;
  return markets;
}

export async function fetchOpenInterest(exchange, symbol, markPrice, { signal, force = false } = {}) {
  const normalizedExchange = String(exchange || "").toLowerCase();
  if (normalizedExchange !== "binance") {
    throw new ExchangeError(`${EXCHANGE_LABELS[normalizedExchange] || exchange} 未平仓额随全量行情获取`);
  }
  const normalizedSymbol = String(symbol || "").toUpperCase().trim();
  if (!normalizedSymbol) throw new ExchangeError("缺少合约代码");
  const cached = binanceOpenInterestCache.get(normalizedSymbol);
  if (!force && cached?.expiresAt > Date.now()) return cached.value;
  const payload = await fetchJson("https://fapi.binance.com/fapi/v1/openInterest", {
    params: { symbol: normalizedSymbol },
    signal,
  });
  const value = positiveProduct(payload?.openInterest, markPrice);
  if (value === null) throw new ExchangeError("Binance 未返回有效未平仓额");
  binanceOpenInterestCache.set(normalizedSymbol, {
    value,
    expiresAt: Date.now() + OPEN_INTEREST_CACHE_MS,
  });
  return value;
}

async function fetchBinanceHistory(symbol, limit, signal) {
  const base = "https://fapi.binance.com";
  const [fundingInfo, payload] = await Promise.all([
    fetchJson(`${base}/fapi/v1/fundingInfo`, { signal }).catch(() => []),
    fetchJson(`${base}/fapi/v1/fundingRate`, {
      params: { symbol: symbol.toUpperCase().trim(), limit: Math.min(limit, 1000) },
      signal,
    }),
  ]);
  const info = rows(fundingInfo).find((row) => row.symbol === symbol.toUpperCase().trim());
  const interval = finite(info?.fundingIntervalHours) || 8;
  return historyResult("binance", symbol.toUpperCase().trim(), interval, rows(payload).map((row) => [row.fundingTime, row.fundingRate]), limit);
}

function okxInterval(row) {
  const current = finite(row?.fundingTime);
  const following = finite(row?.nextFundingTime);
  return current !== null && following !== null && following > current ? (following - current) / 3_600_000 : 8;
}

async function fetchOkxMarkets({ signal }) {
  const base = "https://www.okx.com";
  const [fundingPayload, tickerPayload, oiPayload] = await Promise.all([
    fetchJson(`${base}/api/v5/public/funding-rate`, { params: { instId: "ANY" }, signal }),
    fetchJson(`${base}/api/v5/market/tickers`, { params: { instType: "SWAP" }, signal }).catch(() => ({ data: [] })),
    fetchJson(`${base}/api/v5/public/open-interest`, { params: { instType: "SWAP" }, signal }).catch(() => ({ data: [] })),
  ]);
  const funding = dataRows(fundingPayload);
  if (!funding.length) throw new ExchangeError("OKX 未返回资金费率市场");
  const tickers = new Map(dataRows(tickerPayload).map((row) => [String(row.instId || ""), row]));
  const openInterests = new Map(dataRows(oiPayload).map((row) => [String(row.instId || ""), row]));
  const markets = [];
  for (const row of funding) {
    const symbol = String(row.instId || "");
    if (!symbol.endsWith("-USDT-SWAP")) continue;
    const ticker = tickers.get(symbol) || {};
    const oi = openInterests.get(symbol) || {};
    const mark = finite(ticker.last);
    try {
      markets.push(makeMarket("okx", {
        symbol,
        baseAsset: symbol.slice(0, -"-USDT-SWAP".length),
        quoteAsset: "USDT",
        rate: row.fundingRate,
        intervalHours: okxInterval(row),
        markPrice: mark,
        lastPrice: ticker.last,
        priceChange24h: relativePriceChange(ticker.last, ticker.open24h),
        openInterestUsd: finite(oi.oiUsd) ?? positiveProduct(oi.oiCcy, mark),
        volume24hUsd: positiveProduct(ticker.volCcy24h, mark),
        nextFundingTime: row.fundingTime,
        updatedAt: row.ts,
        nextFundingRate: row.nextFundingRate,
        fundingCap: row.maxFundingRate,
        fundingFloor: row.minFundingRate,
      }));
    } catch (_) {}
  }
  return markets.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function fetchOkxHistory(symbol, limit, signal) {
  const base = "https://www.okx.com";
  const normalizedSymbol = symbol.toUpperCase().trim();
  const current = dataRows(await fetchJson(`${base}/api/v5/public/funding-rate`, { params: { instId: normalizedSymbol }, signal }));
  const interval = current.length ? okxInterval(current[0]) : 8;
  const history = [];
  let after = null;
  while (history.length < limit) {
    const pageSize = Math.min(limit - history.length, 100);
    const page = dataRows(await fetchJson(`${base}/api/v5/public/funding-rate-history`, {
      params: { instId: normalizedSymbol, limit: pageSize, after }, signal,
    }));
    if (!page.length) break;
    history.push(...page);
    const nextAfter = String(page.at(-1)?.fundingTime || "");
    if (page.length < pageSize || !nextAfter || nextAfter === after) break;
    after = nextAfter;
  }
  return historyResult("okx", normalizedSymbol, interval, history.map((row) => [row.fundingTime, row.realizedRate || row.fundingRate]), limit);
}

async function bybitInstruments(symbol, signal) {
  return resultRows(await fetchJson("https://api.bybit.com/v5/market/instruments-info", {
    params: { category: "linear", limit: 1000, symbol }, signal,
  }));
}

async function fetchBybitMarkets({ signal }) {
  const [instruments, tickerPayload] = await Promise.all([
    bybitInstruments(null, signal),
    fetchJson("https://api.bybit.com/v5/market/tickers", { params: { category: "linear" }, signal }),
  ]);
  const tickers = resultRows(tickerPayload);
  if (!tickers.length) throw new ExchangeError("Bybit 未返回资金费率市场");
  const info = new Map(instruments.map((row) => [String(row.symbol || ""), row]));
  const markets = [];
  for (const row of tickers) {
    const symbol = String(row.symbol || "");
    const instrument = info.get(symbol) || {};
    const quote = String(instrument.quoteCoin || "USDT");
    if (quote !== "USDT" || (instrument.contractType && instrument.contractType !== "LinearPerpetual")) continue;
    const minutes = finite(instrument.fundingInterval);
    const interval = finite(row.fundingIntervalHour) ?? (minutes ? minutes / 60 : 8);
    try {
      markets.push(makeMarket("bybit", {
        symbol,
        baseAsset: String(instrument.baseCoin || symbol.slice(0, -4)),
        quoteAsset: quote,
        rate: row.fundingRate,
        intervalHours: interval,
        markPrice: row.markPrice,
        lastPrice: finite(row.lastPrice) ?? row.markPrice,
        priceChange24h: finite(row.price24hPcnt),
        openInterestUsd: row.openInterestValue,
        volume24hUsd: row.turnover24h,
        nextFundingTime: row.nextFundingTime,
        updatedAt: tickerPayload.time,
        nextFundingRate: row.predictedFundingRate,
        fundingCap: instrument.upperFundingRate ?? row.fundingCap,
        fundingFloor: instrument.lowerFundingRate,
      }));
    } catch (_) {}
  }
  return markets.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function fetchBybitHistory(symbol, limit, signal) {
  const normalizedSymbol = symbol.toUpperCase().trim();
  const [instruments, payload] = await Promise.all([
    bybitInstruments(normalizedSymbol, signal),
    fetchJson("https://api.bybit.com/v5/market/funding/history", {
      params: { category: "linear", symbol: normalizedSymbol, limit: Math.min(limit, 200) }, signal,
    }),
  ]);
  const minutes = finite(instruments[0]?.fundingInterval);
  const interval = minutes ? minutes / 60 : 8;
  return historyResult("bybit", normalizedSymbol, interval, resultRows(payload).map((row) => [row.fundingRateTimestamp, row.fundingRate]), limit);
}

async function bitgetInstruments(signal) {
  try {
    const payload = await fetchJson("https://api.bitget.com/api/v3/market/instruments", {
      params: { category: "USDT-FUTURES" }, signal,
    });
    const result = dataRows(payload);
    if (result.length) return result;
  } catch (_) {}
  return dataRows(await fetchJson("https://api.bitget.com/api/v2/mix/market/contracts", {
    params: { productType: "USDT-FUTURES" }, signal,
  }));
}

async function bitgetTickers(signal) {
  try {
    const payload = await fetchJson("https://api.bitget.com/api/v3/market/tickers", {
      params: { category: "USDT-FUTURES" }, signal,
    });
    const result = dataRows(payload);
    if (result.length) return [result, payload.requestTime];
  } catch (_) {}
  const payload = await fetchJson("https://api.bitget.com/api/v2/mix/market/tickers", {
    params: { productType: "USDT-FUTURES" }, signal,
  });
  return [dataRows(payload), payload.requestTime];
}

async function fetchBitgetMarkets({ signal }) {
  const [instruments, tickerResult, currentPayload] = await Promise.all([
    bitgetInstruments(signal),
    bitgetTickers(signal),
    fetchJson("https://api.bitget.com/api/v3/market/current-fund-rate", {
      params: { category: "USDT-FUTURES" }, signal,
    }).catch(() => ({ data: [] })),
  ]);
  const [tickers, requestTime] = tickerResult;
  if (!tickers.length) throw new ExchangeError("Bitget 未返回资金费率市场");
  const info = new Map(instruments.map((row) => [String(row.symbol || ""), row]));
  const current = new Map(dataRows(currentPayload).map((row) => [String(row.symbol || ""), row]));
  const markets = [];
  for (const row of tickers) {
    const symbol = String(row.symbol || "");
    const instrument = info.get(symbol) || {};
    const funding = current.get(symbol) || {};
    const quote = String(instrument.quoteCoin || "USDT");
    if (quote !== "USDT") continue;
    const interval = finite(funding.fundingRateInterval) || finite(instrument.fundInterval) || 8;
    const mark = row.markPrice;
    const last = finite(row.lastPrice) ?? finite(row.lastPr) ?? mark;
    const change24h = finite(row.price24hPcnt)
      ?? finite(row.change24h)
      ?? relativePriceChange(last, row.openPrice24h ?? row.open24h);
    try {
      markets.push(makeMarket("bitget", {
        symbol,
        baseAsset: String(instrument.baseCoin || symbol.slice(0, -4)),
        quoteAsset: quote,
        rate: funding.fundingRate ?? row.fundingRate,
        intervalHours: interval,
        markPrice: mark,
        lastPrice: last,
        priceChange24h: change24h,
        openInterestUsd: positiveProduct(row.openInterest ?? row.holdingAmount, mark),
        volume24hUsd: row.turnover24h ?? row.quoteVolume ?? row.usdtVolume,
        nextFundingTime: funding.nextUpdate || futureBoundaryMs(interval),
        updatedAt: row.ts ?? requestTime,
        fundingCap: funding.maxFundingRate,
        fundingFloor: funding.minFundingRate,
      }));
    } catch (_) {}
  }
  return markets.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function fetchBitgetHistory(symbol, limit, signal) {
  const normalizedSymbol = symbol.toUpperCase().trim();
  const instruments = await bitgetInstruments(signal);
  const info = instruments.find((row) => row.symbol === normalizedSymbol);
  const interval = finite(info?.fundInterval) || 8;
  let history = [];
  try {
    let cursor = 1;
    while (history.length < limit) {
      const pageSize = Math.min(limit - history.length, 100);
      const payload = await fetchJson("https://api.bitget.com/api/v3/market/history-fund-rate", {
        params: { category: "USDT-FUTURES", symbol: normalizedSymbol, limit: pageSize, cursor }, signal,
      });
      const page = rows(payload?.data?.resultList);
      if (!page.length) break;
      history.push(...page);
      if (page.length < pageSize) break;
      cursor += 1;
    }
  } catch (_) {
    history = [];
  }
  if (!history.length) {
    let pageNo = 1;
    while (history.length < limit) {
      const pageSize = Math.min(limit - history.length, 100);
      const payload = await fetchJson("https://api.bitget.com/api/v2/mix/market/history-fund-rate", {
        params: { productType: "USDT-FUTURES", symbol: normalizedSymbol, pageSize, pageNo }, signal,
      });
      const page = dataRows(payload);
      if (!page.length) break;
      history.push(...page);
      if (page.length < pageSize) break;
      pageNo += 1;
    }
  }
  return historyResult("bitget", normalizedSymbol, interval, history.map((row) => [row.fundingRateTimestamp ?? row.fundingTime, row.fundingRate]), limit);
}

function hyperliquidMarkets(payload) {
  if (!Array.isArray(payload) || payload.length < 2) throw new ExchangeError("Hyperliquid 市场响应无效");
  const universe = rows(payload[0]?.universe);
  const contexts = rows(payload[1]);
  if (!universe.length || !contexts.length) throw new ExchangeError("Hyperliquid 未返回资金费率市场");
  const nextHour = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
  const markets = [];
  universe.forEach((instrument, index) => {
    if (instrument.isDelisted === true) return;
    const context = contexts[index] || {};
    const symbol = String(instrument.name || "");
    const mark = finite(context.markPx);
    const latest = finite(context.midPx) ?? mark;
    try {
      markets.push(makeMarket("hyperliquid", {
        symbol,
        baseAsset: symbol,
        quoteAsset: "USDC",
        rate: context.funding,
        intervalHours: 1,
        markPrice: mark,
        lastPrice: latest,
        priceChange24h: relativePriceChange(latest, context.prevDayPx),
        openInterestUsd: positiveProduct(context.openInterest, mark),
        volume24hUsd: context.dayNtlVlm,
        nextFundingTime: nextHour,
        updatedAt: new Date().toISOString(),
        fundingCap: 0.04,
        fundingFloor: -0.04,
      }));
    } catch (_) {}
  });
  return markets;
}

async function fetchHyperliquidMarkets({ signal }) {
  const base = "https://api.hyperliquid.xyz/info";
  const main = await fetchJson(base, { method: "POST", body: { type: "metaAndAssetCtxs" }, signal });
  const markets = hyperliquidMarkets(main);
  let dexNames = [];
  try {
    const dexPayload = await fetchJson(base, { method: "POST", body: { type: "perpDexs" }, signal });
    dexNames = rows(dexPayload).map((row) => String(row.name || "")).filter(Boolean);
  } catch (_) {}
  const dexResults = await Promise.allSettled(dexNames.map(async (dex) => hyperliquidMarkets(await fetchJson(base, {
    method: "POST", body: { type: "metaAndAssetCtxs", dex }, signal,
  }))));
  for (const result of dexResults) if (result.status === "fulfilled") markets.push(...result.value);
  const unique = new Map(markets.map((market) => [`${market.symbol}:${market.quote_asset}`, market]));
  return [...unique.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function fetchHyperliquidHistory(symbol, limit, signal) {
  const normalizedSymbol = symbol.trim();
  const startTime = Date.now() - Math.max(limit * 2, 48) * 3_600_000;
  const payload = await fetchJson("https://api.hyperliquid.xyz/info", {
    method: "POST",
    body: { type: "fundingHistory", coin: normalizedSymbol, startTime },
    signal,
  });
  return historyResult("hyperliquid", normalizedSymbol, 1, rows(payload).map((row) => [row.time, row.fundingRate]), limit);
}

const MARKET_FETCHERS = {
  binance: fetchBinanceMarkets,
  okx: fetchOkxMarkets,
  bybit: fetchBybitMarkets,
  bitget: fetchBitgetMarkets,
  hyperliquid: fetchHyperliquidMarkets,
};

const HISTORY_FETCHERS = {
  binance: fetchBinanceHistory,
  okx: fetchOkxHistory,
  bybit: fetchBybitHistory,
  bitget: fetchBitgetHistory,
  hyperliquid: fetchHyperliquidHistory,
};

export async function fetchMarkets(exchange, { signal, onProgress, force = false } = {}) {
  const normalizedExchange = String(exchange || "").toLowerCase();
  const fetcher = MARKET_FETCHERS[normalizedExchange];
  if (!fetcher) throw new ExchangeError(`不支持的交易所：${exchange}`);
  const cached = marketCache.get(normalizedExchange);
  if (!force && cached?.expiresAt > Date.now()) {
    const copy = cached.markets.map((market) => ({ ...market }));
    onProgress?.(copy);
    return copy;
  }
  const markets = await fetcher({ signal, onProgress });
  marketCache.set(normalizedExchange, {
    markets: markets.map((market) => ({ ...market })),
    expiresAt: Date.now() + MARKET_CACHE_MS,
  });
  return markets;
}

export async function fetchHistory(exchange, symbol, limit = 200, { signal } = {}) {
  const normalizedExchange = String(exchange || "").toLowerCase();
  const fetcher = HISTORY_FETCHERS[normalizedExchange];
  if (!fetcher) throw new ExchangeError(`不支持的交易所：${exchange}`);
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  return fetcher(String(symbol || ""), boundedLimit, signal);
}

export function clearCachesForTests() {
  marketCache.clear();
  binanceOpenInterestCache.clear();
  binanceMetadataCache = null;
}
