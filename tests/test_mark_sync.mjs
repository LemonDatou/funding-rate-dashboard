import assert from "node:assert/strict";
import test from "node:test";

import { binanceMarkKeys, parseMarkSyncHash } from "../web/mark-sync.js";

test("mark sync fragment validates, normalizes, and deduplicates assets", () => {
  assert.deepEqual(parseMarkSyncHash("#mark-sync=1:xec%2CMMT%2Cxec"), {
    assets: ["MMT", "XEC"],
  });
  assert.equal(parseMarkSyncHash("#theme=dark"), null);
  assert.match(parseMarkSyncHash("#mark-sync=2:XEC").error, /版本/);
  assert.match(parseMarkSyncHash("#mark-sync=1:XEC%3Cscript%3E").error, /格式/);
});

test("mark sync maps Binance contract denominations and reports misses", () => {
  const result = binanceMarkKeys([
    { exchange: "binance", symbol: "1000XECUSDT", base_asset: "1000XEC" },
    { exchange: "binance", symbol: "MMTUSDT", base_asset: "MMT" },
    { exchange: "okx", symbol: "MMT-USDT-SWAP", base_asset: "MMT" },
  ], ["XEC", "MMT", "MISSING"]);

  assert.deepEqual(result.keys, ["binance:1000XECUSDT", "binance:MMTUSDT"]);
  assert.deepEqual(result.matchedAssets, ["MMT", "XEC"]);
  assert.deepEqual(result.unmatchedAssets, ["MISSING"]);
});
