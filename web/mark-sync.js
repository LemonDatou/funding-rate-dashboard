export const MARK_SYNC_PARAM = "mark-sync";

const MARK_SYNC_VERSION = "1";
const MAX_MARK_SYNC_ASSETS = 200;
const MAX_MARK_SYNC_VALUE_LENGTH = 4_096;
const ASSET_PATTERN = /^[A-Z0-9]{1,20}$/;
const BINANCE_CONTRACT_MULTIPLIER = /^(?:1000000|1000)(?=.+$)/;

function normalizedAssets(values) {
  if (!Array.isArray(values)) throw new TypeError("标记同步币种格式无效");
  if (values.length > MAX_MARK_SYNC_ASSETS) throw new TypeError("标记同步币种过多");
  const assets = [...new Set(values.map((value) => String(value || "").trim().toUpperCase()))];
  if (!assets.length || assets.some((asset) => !ASSET_PATTERN.test(asset))) {
    throw new TypeError("标记同步币种格式无效");
  }
  return assets.sort();
}

export function parseMarkSyncHash(hash) {
  const parameters = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (!parameters.has(MARK_SYNC_PARAM)) return null;
  const value = parameters.get(MARK_SYNC_PARAM) || "";
  if (!value || value.length > MAX_MARK_SYNC_VALUE_LENGTH) {
    return { error: "标记同步内容为空或过长" };
  }
  const separator = value.indexOf(":");
  if (separator < 0 || value.slice(0, separator) !== MARK_SYNC_VERSION) {
    return { error: "标记同步版本不受支持" };
  }
  try {
    return { assets: normalizedAssets(value.slice(separator + 1).split(",")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "标记同步内容无效" };
  }
}

export function binanceMarkKeys(markets, rawAssets) {
  const assets = normalizedAssets(rawAssets);
  const supported = new Set(assets);
  const keys = new Set();
  const matchedAssets = new Set();
  for (const market of Array.isArray(markets) ? markets : []) {
    if (market?.exchange !== "binance") continue;
    const symbol = String(market.symbol || "").trim().toUpperCase();
    const baseAsset = String(market.base_asset || "").split(":").pop().trim().toUpperCase();
    if (!symbol || !baseAsset) continue;
    const candidates = [baseAsset, baseAsset.replace(BINANCE_CONTRACT_MULTIPLIER, "")];
    const asset = candidates.find((candidate) => supported.has(candidate));
    if (!asset) continue;
    keys.add(`binance:${symbol}`);
    matchedAssets.add(asset);
  }
  return {
    keys: [...keys].sort(),
    matchedAssets: [...matchedAssets].sort(),
    unmatchedAssets: assets.filter((asset) => !matchedAssets.has(asset)),
  };
}
