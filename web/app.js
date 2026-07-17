import {
  EXCHANGES,
  EXCHANGE_LABELS,
  fetchHistory,
  fetchMarkets,
  fetchOpenInterest,
} from "./exchanges.js";

(() => {
  "use strict";

  const INTERVALS = { "-1": null, 0: 1, 1: 2, 2: 4, 3: 8 };
  const state = {
    markets: [],
    errors: {},
    loadedExchanges: new Set(),
    loadingExchanges: new Set(),
    exchangeControllers: new Map(),
    unit: "1y",
    sortKey: "funding_rate_1y",
    sortDirection: "desc",
    selectedExchanges: new Set(["binance"]),
    minVolume: 10 ** 6,
    intervalHours: null,
    search: "",
    loadingOpenInterest: new Set(),
    generatedAt: null,
    history: null,
    historyRequestId: 0,
  };

  const $ = (selector) => document.querySelector(selector);
  const rowsElement = $("#market-rows");
  const dialog = $("#history-dialog");
  const canvas = $("#history-chart");
  const tooltip = $("#chart-tooltip");

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseDate(value) {
    const numeric = finite(value);
    const timestamp = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))
      ? numeric
      : value;
    return new Date(timestamp);
  }

  function formatMoney(value) {
    const number = finite(value);
    if (number === null) return "—";
    const absolute = Math.abs(number);
    if (absolute >= 1e12) return `$${(number / 1e12).toFixed(2)}T`;
    if (absolute >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
    if (absolute >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
    if (absolute >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
    return `$${number.toFixed(0)}`;
  }

  function formatPrice(value) {
    const number = finite(value);
    if (number === null) return "—";
    const absolute = Math.abs(number);
    if (absolute >= 1000) return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (absolute >= 1) return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
    if (absolute >= 0.01) return number.toFixed(5);
    return number.toPrecision(5);
  }

  function formatRate(value) {
    const number = finite(value);
    if (number === null) return "—";
    const percent = number * 100;
    const roundedPercent = Number(percent.toFixed(4));
    return `${Object.is(roundedPercent, -0) ? "0.0000" : roundedPercent.toFixed(4)}%`;
  }

  function formatThreshold(value) {
    if (value >= 1e9) return `$${value / 1e9}B`;
    if (value >= 1e6) return `$${value / 1e6}M`;
    if (value >= 1e3) return `$${value / 1e3}K`;
    return `$${value}`;
  }

  function formatTimestamp(value) {
    if (!value) return "—";
    const date = parseDate(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function countdown(value) {
    if (!value) return "—";
    const milliseconds = parseDate(value).getTime() - Date.now();
    if (!Number.isFinite(milliseconds)) return "—";
    if (milliseconds <= 0) return "结算中";
    const totalMinutes = Math.ceil(milliseconds / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days) return `${days}d ${hours}h`;
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  function rateClass(value) {
    const number = finite(value);
    if (number === null || number === 0) return "rate-zero";
    return number > 0 ? "rate-positive" : "rate-negative";
  }

  function normalizeRate(rate, intervalHours, unit = state.unit) {
    const raw = finite(rate);
    const interval = finite(intervalHours);
    if (raw === null || interval === null || interval <= 0) return null;
    return unit === "8h" ? raw * 8 / interval : raw * 24 * 365 / interval;
  }

  function fundingBounds(market) {
    let cap = finite(market.funding_cap);
    let floor = finite(market.funding_floor);
    if (cap === null && floor === null) return "—";
    if (cap !== null && floor === null) floor = -Math.abs(cap);
    if (floor !== null && cap === null) cap = Math.abs(floor);
    if (cap >= 0 && floor <= 0 && formatRate(Math.abs(cap)) === formatRate(Math.abs(floor))) {
      return `±${formatRate(Math.abs(cap))}`;
    }
    const signedRate = (value) => `${value >= 0 ? "+" : ""}${formatRate(value)}`;
    return `${signedRate(cap)} / ${signedRate(floor)}`;
  }

  function cell(text, className = "") {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function displaySymbol(market) {
    let symbol;
    if (market.base_asset && market.quote_asset) {
      const base = String(market.base_asset).split(":").pop();
      symbol = `${base}/${market.quote_asset}`;
    } else {
      symbol = market.symbol;
    }
    return market.exchange === "binance" && market.asset_label
      ? `${symbol} (${market.asset_label})`
      : symbol;
  }

  function visibleMarkets() {
    const query = state.search.trim().toUpperCase();
    const rateKey = `funding_rate_${state.unit}`;
    return state.markets
      .filter((market) => state.selectedExchanges.has(market.exchange))
      .filter((market) => (finite(market.volume_24h_usd) ?? 0) >= state.minVolume)
      .filter((market) => state.intervalHours === null || Math.abs((finite(market.interval_hours) ?? -999) - state.intervalHours) < 0.01)
      .filter((market) => !query || `${market.symbol} ${displaySymbol(market)}`.toUpperCase().includes(query))
      .sort((left, right) => compareMarkets(left, right, state.sortKey === "funding_rate" ? rateKey : state.sortKey));
  }

  function compareMarkets(left, right, key) {
    let a = sortValue(left, key);
    let b = sortValue(right, key);
    const aNumber = finite(a);
    const bNumber = finite(b);
    if (aNumber !== null || bNumber !== null) {
      if (aNumber === null) return 1;
      if (bNumber === null) return -1;
      a = aNumber;
      b = bNumber;
    } else {
      if (a == null) return 1;
      if (b == null) return -1;
      a = String(a).toLowerCase();
      b = String(b).toLowerCase();
    }
    const direction = state.sortDirection === "asc" ? 1 : -1;
    return a < b ? -direction : a > b ? direction : 0;
  }

  function sortValue(market, key) {
    if (key === "next_funding_rate") return finite(market.next_funding_rate) ?? finite(market.funding_rate);
    if (key === "funding_bounds") {
      const cap = finite(market.funding_cap);
      const floor = finite(market.funding_floor);
      return cap !== null && floor !== null ? cap - floor : cap ?? (floor !== null ? Math.abs(floor) : null);
    }
    return market[key];
  }

  async function loadOpenInterest(market) {
    const key = `${market.exchange}:${market.symbol}`;
    if (state.loadingOpenInterest.has(key)) return;
    state.loadingOpenInterest.add(key);
    renderRows();
    try {
      const value = await fetchOpenInterest(
        market.exchange,
        market.symbol,
        market.mark_price,
      );
      const current = state.markets.find((item) => `${item.exchange}:${item.symbol}` === key);
      if (current) current.open_interest_usd = value;
    } catch (error) {
      showToast(`${market.exchange_label || market.exchange} ${displaySymbol(market)} 未平仓额加载失败`);
    } finally {
      state.loadingOpenInterest.delete(key);
      renderRows();
    }
  }

  function openInterestCell(market) {
    const value = finite(market.open_interest_usd);
    if (value !== null) return cell(formatMoney(value), "numeric oi-cell");
    const td = cell("", "numeric oi-cell");
    if (market.exchange !== "binance") return td;
    const key = `${market.exchange}:${market.symbol}`;
    const loading = state.loadingOpenInterest.has(key);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "oi-load";
    button.disabled = loading;
    button.textContent = loading ? "…" : "";
    button.title = loading ? "正在加载未平仓额" : `点击加载 ${displaySymbol(market)} 未平仓额`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      loadOpenInterest(market);
    });
    td.append(button);
    return td;
  }

  function renderRows() {
    const markets = visibleMarkets();
    const selectedTotal = state.markets.filter((market) => state.selectedExchanges.has(market.exchange)).length;
    rowsElement.replaceChildren();
    if (state.loadingExchanges.size && selectedTotal === 0) {
      const labels = [...state.loadingExchanges].map((exchange) => EXCHANGE_LABELS[exchange]);
      $("#market-count").textContent = `正在连接 ${labels.join("、")}…`;
    } else {
      const suffix = state.loadingExchanges.size ? " · 正在补充市场数据…" : "";
      $("#market-count").textContent = `${markets.length.toLocaleString()} / ${selectedTotal.toLocaleString()} 个市场${suffix}`;
    }

    if (!markets.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      const td = cell(selectedTotal ? "当前筛选条件下没有市场" : (state.loadingExchanges.size ? "正在加载…" : "暂无可用数据"));
      td.colSpan = 8;
      tr.append(td);
      rowsElement.append(tr);
      updateSortIndicators();
      return;
    }

    const fragment = document.createDocumentFragment();
    const rateKey = `funding_rate_${state.unit}`;
    for (const market of markets) {
      const tr = document.createElement("tr");
      tr.dataset.marketKey = `${market.exchange}:${market.symbol}`;
      tr.title = "点击查看历史资金费率";

      const symbolCell = document.createElement("td");
      const symbolButton = document.createElement("button");
      symbolButton.type = "button";
      symbolButton.className = "symbol-button";
      symbolButton.setAttribute("aria-haspopup", "dialog");
      symbolButton.setAttribute("aria-label", `查看 ${displaySymbol(market)} 历史资金费率`);
      symbolButton.textContent = displaySymbol(market);
      symbolCell.append(symbolButton);
      if (market.stale) {
        const dot = document.createElement("span");
        dot.className = "stale-dot";
        dot.title = "当前交易所正在使用最近一次成功缓存";
        symbolButton.append(dot);
      }
      const exchangeCell = cell(market.exchange_label || market.exchange, "exchange-cell");
      const rateCell = cell(formatRate(market[rateKey]), `numeric ${rateClass(market[rateKey])}`);
      const interval = finite(market.interval_hours);
      const intervalCell = cell(interval === null ? "—" : `${interval}H`, "numeric interval-cell");
      const nextRate = finite(market.next_funding_rate) ?? finite(market.funding_rate);
      const nextCell = document.createElement("td");
      nextCell.className = `numeric countdown-cell ${rateClass(nextRate)}`;
      const countdownSpan = document.createElement("span");
      countdownSpan.dataset.countdown = "";
      countdownSpan.dataset.nextFundingTime = market.next_funding_time || "";
      countdownSpan.textContent = countdown(market.next_funding_time);
      const nextRateSpan = document.createElement("span");
      nextRateSpan.textContent = ` ${formatRate(nextRate)}`;
      nextCell.append(countdownSpan, nextRateSpan);

      tr.append(
        exchangeCell,
        symbolCell,
        rateCell,
        nextCell,
        cell(fundingBounds(market), "numeric"),
        intervalCell,
        cell(formatMoney(market.volume_24h_usd), "numeric"),
        openInterestCell(market),
      );
      tr.addEventListener("click", () => openHistory(market));
      fragment.append(tr);
    }
    rowsElement.append(fragment);
    updateSortIndicators();
  }

  function updateSortIndicators() {
    const actualRateKey = `funding_rate_${state.unit}`;
    document.querySelectorAll("thead button[data-sort]").forEach((button) => {
      const span = button.querySelector("span");
      const buttonKey = button.id === "rate-heading" ? actualRateKey : button.dataset.sort;
      const active = buttonKey === state.sortKey;
      span.textContent = active ? (state.sortDirection === "asc" ? "↑" : "↓") : "";
      button.closest("th").setAttribute("aria-sort", active ? (state.sortDirection === "asc" ? "ascending" : "descending") : "none");
    });
  }

  function updateCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach((element) => {
      element.textContent = countdown(element.dataset.nextFundingTime);
    });
  }

  function showErrors(errors) {
    const entries = Object.entries(errors || {}).filter(([, message]) => message);
    const element = $("#error-summary");
    const details = $("#error-details");
    if (!entries.length) {
      element.hidden = true;
      element.removeAttribute("title");
      element.setAttribute("aria-expanded", "false");
      details.hidden = true;
      details.replaceChildren();
      return;
    }
    element.hidden = false;
    element.textContent = `${entries.length} 个交易所异常`;
    element.title = entries.map(([exchange, message]) => `${exchange}: ${message}`).join("\n");
    details.replaceChildren();
    for (const [exchange, message] of entries) {
      const line = document.createElement("p");
      line.textContent = `${exchange}: ${message}`;
      details.append(line);
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 4_500);
  }

  function replaceExchangeMarkets(exchange, markets) {
    state.markets = [
      ...state.markets.filter((market) => market.exchange !== exchange),
      ...markets,
    ];
  }

  function updateLoadingUI() {
    const refreshButton = $("#refresh");
    const loading = state.loadingExchanges.size > 0;
    refreshButton.disabled = loading;
    refreshButton.classList.toggle("loading", loading);
  }

  function disableExchange(exchange, error) {
    const input = document.querySelector(`#exchange-filters input[value="${exchange}"]`);
    if (input) {
      input.checked = false;
      input.disabled = true;
      input.closest("label").title = "本次加载失败；刷新页面后可重试";
    }
    state.selectedExchanges.delete(exchange);
    replaceExchangeMarkets(exchange, []);
    state.errors[exchange] = error instanceof Error ? error.message : String(error);
    showErrors(state.errors);
    showToast(`${EXCHANGE_LABELS[exchange]} 数据加载失败，已取消并停用`);
  }

  async function loadExchange(exchange, { force = false } = {}) {
    if (!EXCHANGES.includes(exchange) || state.loadingExchanges.has(exchange)) return;
    if (!force && state.loadedExchanges.has(exchange)) return;

    const controller = new AbortController();
    state.exchangeControllers.get(exchange)?.abort();
    state.exchangeControllers.set(exchange, controller);
    state.loadingExchanges.add(exchange);
    delete state.errors[exchange];
    showErrors(state.errors);
    updateLoadingUI();
    renderRows();

    try {
      const markets = await fetchMarkets(exchange, {
        signal: controller.signal,
        force,
        onProgress: (partialMarkets) => {
          if (controller.signal.aborted) return;
          replaceExchangeMarkets(exchange, partialMarkets);
          renderRows();
        },
      });
      if (controller.signal.aborted) return;
      replaceExchangeMarkets(exchange, markets);
      state.loadedExchanges.add(exchange);
      state.generatedAt = new Date().toISOString();
      $("#freshness").textContent = `更新于 ${formatTimestamp(state.generatedAt)}`;
    } catch (error) {
      if (error?.name !== "AbortError") disableExchange(exchange, error);
    } finally {
      if (state.exchangeControllers.get(exchange) === controller) {
        state.exchangeControllers.delete(exchange);
      }
      state.loadingExchanges.delete(exchange);
      updateLoadingUI();
      renderRows();
    }
  }

  async function refreshSelectedExchanges() {
    const exchanges = [...state.selectedExchanges];
    await Promise.all(exchanges.map((exchange) => loadExchange(exchange, { force: true })));
  }

  function historyValue(point) {
    return finite(point[`rate_${state.unit}`]);
  }

  function renderHistoryStats() {
    if (!state.history?.points?.length) return;
    const values = state.history.points.map(historyValue).filter((value) => value !== null);
    if (!values.length) return;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const latest = values[values.length - 1];
    const items = [
      ["最新", formatRate(latest)],
      ["平均", formatRate(average)],
      ["最低", formatRate(Math.min(...values))],
      ["最高", formatRate(Math.max(...values))],
    ];
    const container = $("#history-stats");
    container.replaceChildren();
    for (const [label, value] of items) {
      const item = document.createElement("div");
      item.className = "stat";
      const caption = document.createElement("span");
      caption.textContent = `${label} · ${state.unit.toUpperCase()}`;
      const amount = document.createElement("strong");
      amount.textContent = value;
      item.append(caption, amount);
      container.append(item);
    }
    renderHistoryData();
  }

  function renderHistoryData() {
    const body = $("#history-data-rows");
    body.replaceChildren();
    if (!state.history?.points?.length) return;
    const fragment = document.createDocumentFragment();
    for (const point of [...state.history.points].reverse()) {
      const row = document.createElement("tr");
      row.append(cell(formatTimestamp(point.timestamp)), cell(formatRate(historyValue(point)), `numeric ${rateClass(historyValue(point))}`));
      fragment.append(row);
    }
    body.append(fragment);
  }

  async function openHistory(market) {
    const requestId = ++state.historyRequestId;
    state.history = null;
    $("#history-exchange").textContent = `${market.exchange_label || market.exchange} · ${market.interval_hours}H`;
    $("#history-title").textContent = `${displaySymbol(market)} 历史资金费率`;
    $("#history-status").hidden = false;
    $("#history-status").textContent = "加载中…";
    $("#history-content").hidden = true;
    if (!dialog.open) dialog.showModal();

    try {
      const payload = await fetchHistory(market.exchange, market.symbol, 200);
      if (requestId !== state.historyRequestId || !dialog.open) return;
      const points = Array.isArray(payload.points) ? payload.points : [];
      if (!points.length) throw new Error("该市场暂无公开历史记录");
      state.history = { ...payload, points, market };
      $("#history-status").hidden = true;
      $("#history-content").hidden = false;
      renderHistoryStats();
      requestAnimationFrame(drawHistoryChart);
    } catch (error) {
      if (requestId !== state.historyRequestId || !dialog.open) return;
      $("#history-status").textContent = error instanceof Error ? error.message : String(error);
      showToast(`${market.exchange_label || market.exchange} 历史费率加载失败`);
    }
  }

  function drawHistoryChart() {
    if (!state.history?.points?.length || $("#history-content").hidden) return;
    const points = state.history.points
      .map((point) => ({ point, value: historyValue(point), time: parseDate(point.timestamp).getTime() }))
      .filter((item) => item.value !== null && Number.isFinite(item.time));
    if (!points.length) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const styles = getComputedStyle(document.documentElement);
    const colors = {
      text: styles.getPropertyValue("--muted").trim(),
      line: styles.getPropertyValue("--line-soft").trim(),
      accent: styles.getPropertyValue("--accent").trim(),
      zero: styles.getPropertyValue("--line").trim(),
    };
    const width = rect.width;
    const height = rect.height;
    const padding = { top: 18, right: 18, bottom: 34, left: 70 };
    const plotWidth = Math.max(1, width - padding.left - padding.right);
    const plotHeight = Math.max(1, height - padding.top - padding.bottom);
    let minimum = Math.min(...points.map((item) => item.value));
    let maximum = Math.max(...points.map((item) => item.value));
    if (minimum === maximum) {
      const spread = Math.abs(minimum) || 0.000001;
      minimum -= spread * 0.2;
      maximum += spread * 0.2;
    } else {
      const spread = maximum - minimum;
      minimum -= spread * 0.08;
      maximum += spread * 0.08;
    }
    const minTime = points[0].time;
    const maxTime = points[points.length - 1].time;
    const timeSpread = Math.max(1, maxTime - minTime);
    const xFor = (time) => padding.left + ((time - minTime) / timeSpread) * plotWidth;
    const yFor = (value) => padding.top + ((maximum - value) / (maximum - minimum)) * plotHeight;

    context.clearRect(0, 0, width, height);
    context.font = '11px "SFMono-Regular", Consolas, monospace';
    context.fillStyle = colors.text;
    context.strokeStyle = colors.line;
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const ratioY = index / 4;
      const y = padding.top + ratioY * plotHeight;
      const value = maximum - ratioY * (maximum - minimum);
      context.beginPath();
      context.moveTo(padding.left, y + 0.5);
      context.lineTo(width - padding.right, y + 0.5);
      context.stroke();
      context.textAlign = "right";
      context.textBaseline = "middle";
      context.fillText(formatRate(value, true), padding.left - 8, y);
    }
    if (minimum < 0 && maximum > 0) {
      const zeroY = yFor(0);
      context.strokeStyle = colors.zero;
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(padding.left, zeroY);
      context.lineTo(width - padding.right, zeroY);
      context.stroke();
      context.setLineDash([]);
    }

    context.strokeStyle = colors.accent;
    context.lineWidth = 1.6;
    context.beginPath();
    points.forEach((item, index) => {
      const x = xFor(item.time);
      const y = yFor(item.value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();

    context.fillStyle = colors.text;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(formatTimestamp(points[0].point.timestamp), padding.left, height - 23);
    context.textAlign = "right";
    context.fillText(formatTimestamp(points[points.length - 1].point.timestamp), width - padding.right, height - 23);
    canvas._chartGeometry = { points, padding, plotWidth, xFor, yFor };
  }

  function handleChartPointer(event) {
    const geometry = canvas._chartGeometry;
    if (!geometry?.points?.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < geometry.padding.left || x > geometry.padding.left + geometry.plotWidth) {
      tooltip.hidden = true;
      return;
    }
    let nearest = geometry.points[0];
    let distance = Infinity;
    for (const item of geometry.points) {
      const nextDistance = Math.abs(geometry.xFor(item.time) - x);
      if (nextDistance < distance) {
        nearest = item;
        distance = nextDistance;
      }
    }
    tooltip.hidden = false;
    tooltip.textContent = `${formatTimestamp(nearest.point.timestamp)} · ${formatRate(nearest.value)}`;
    tooltip.style.left = `${geometry.xFor(nearest.time)}px`;
    tooltip.style.top = `${geometry.yFor(nearest.value)}px`;
  }

  function applyTheme(value) {
    const theme = value === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : value;
    document.documentElement.dataset.theme = theme;
    if (state.history) requestAnimationFrame(drawHistoryChart);
  }

  function bindControls() {
    const volumeInput = $("#volume-filter");
    const intervalInput = $("#interval-filter");

    volumeInput.addEventListener("input", () => {
      state.minVolume = 10 ** Number(volumeInput.value);
      $("#volume-value").textContent = formatThreshold(state.minVolume);
      renderRows();
    });
    intervalInput.addEventListener("input", () => {
      state.intervalHours = INTERVALS[intervalInput.value];
      $("#interval-value").textContent = state.intervalHours === null ? "*H" : `${state.intervalHours}H`;
      renderRows();
    });
    $("#exchange-filters").addEventListener("change", async (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const exchange = event.target.value;
      if (event.target.checked) {
        state.selectedExchanges.add(exchange);
        renderRows();
        await loadExchange(exchange);
        return;
      }
      state.selectedExchanges.delete(exchange);
      state.exchangeControllers.get(exchange)?.abort();
      renderRows();
    });
    $("#search").addEventListener("input", (event) => {
      state.search = event.target.value;
      renderRows();
    });
    $("#refresh").addEventListener("click", refreshSelectedExchanges);
    $("#error-summary").addEventListener("click", () => {
      const details = $("#error-details");
      details.hidden = !details.hidden;
      $("#error-summary").setAttribute("aria-expanded", String(!details.hidden));
    });

    document.querySelectorAll("[data-unit]").forEach((button) => {
      button.addEventListener("click", () => {
        const previousRateKey = `funding_rate_${state.unit}`;
        state.unit = button.dataset.unit;
        document.querySelectorAll("[data-unit]").forEach((candidate) => {
          const active = candidate.dataset.unit === state.unit;
          candidate.classList.toggle("active", active);
          candidate.setAttribute("aria-pressed", String(active));
        });
        $("#rate-heading").childNodes[0].textContent = `资金费率 ${state.unit.toUpperCase()} `;
        if (state.sortKey === previousRateKey) state.sortKey = `funding_rate_${state.unit}`;
        renderRows();
        if (state.history) {
          renderHistoryStats();
          requestAnimationFrame(drawHistoryChart);
        }
      });
    });

    document.querySelectorAll("thead button[data-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.id === "rate-heading" ? `funding_rate_${state.unit}` : button.dataset.sort;
        if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
        else {
          state.sortKey = key;
          state.sortDirection = ["symbol", "exchange", "next_funding_time"].includes(key) ? "asc" : "desc";
        }
        renderRows();
      });
    });

    $("#dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      state.historyRequestId += 1;
      state.history = null;
      tooltip.hidden = true;
    });
    canvas.addEventListener("pointermove", handleChartPointer);
    canvas.addEventListener("pointerleave", () => { tooltip.hidden = true; });

    const themeSelect = $("#theme-select");
    const storedTheme = localStorage.getItem("funding-matrix-theme") || "system";
    themeSelect.value = storedTheme;
    applyTheme(storedTheme);
    themeSelect.addEventListener("change", () => {
      localStorage.setItem("funding-matrix-theme", themeSelect.value);
      applyTheme(themeSelect.value);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (themeSelect.value === "system") applyTheme("system");
    });
    window.addEventListener("resize", () => requestAnimationFrame(drawHistoryChart));
  }

  bindControls();
  loadExchange("binance");
  setInterval(updateCountdowns, 30_000);
})();
