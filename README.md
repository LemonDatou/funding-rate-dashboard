# Funding Rate Dashboard

五家交易所的纯前端永续合约资金费率看板，独立于套利策略、账户和下单服务运行。

## 功能

- 支持 Binance、OKX、Bybit、Bitget 和 Hyperliquid
- 支持按交易所、币种、未平仓额、现货成交额、合约成交额、资金费率、下次资金费率和结算周期排序或筛选
- Binance Alpha 与股票类合约默认隐藏，可分别开启显示；股票类涵盖股票/ETF、港股、韩股、指数、盘前和大宗商品
- 点击币名可切换本地红色标记，“标记”筛选仅显示已标记市场；标记保存在当前浏览器
- 资金费率可在 8H 等效费率和 1Y 简单年化之间切换
- 资金费率后显示 Margin Pool 最新杠杆借币日利率的简单年化值，并支持排序
- 点击币名切换红色标记；点击行内其他区域打开历史资金费率；点击最新价格会在新标签打开对应交易所的合约页面；点击借款利息会在新标签打开对应 Margin Pool 资产
- 点击任意市场可查看历史资金费率；Binance 请求最近最多 1,000 条，其他交易所维持最近 200 条
- 历史曲线提供独立的全量时间轴双滑块，曲线横轴随选中时间窗口动态缩放
- 对可跳转到 Margin Pool 的 Binance 币种，历史图同时显示已采集的借币利率曲线和联合悬停值
- 浏览器只在勾选交易所时直连其公开 API，不再等待全市场聚合服务
- 单个交易所失败时自动取消勾选、禁用并显示临时提示，不阻断其他市场
- 页面首次打开时仅展示 Binance，可手动勾选其他交易所
- Binance 交易对按主资产类型显示标签；普通 COIN 不标记，Alpha 单独标记

1Y 使用简单年化：`8H 等效费率 × 3 × 365`，不是复利 APY。

## 本地运行

```bash
./run_dashboard.sh
```

浏览器访问 <http://127.0.0.1:8000>。可通过 `DASHBOARD_HOST`、`DASHBOARD_PORT` 或
`PYTHON` 环境变量覆盖监听地址、端口和 Python 解释器。Python 只负责提供静态文件，
不请求、聚合或保存任何交易所数据。

生产环境：<https://sg.nbiggerhead.com/funding-rate/>

## 数据流

- 首次打开只请求 Binance；勾选其他交易所时才请求对应公开 API。
- Binance 先用合约批量接口展示基础行情，再渐进补充资产标签、Alpha/现货成交额和逐合约未平仓量；合约参数和分类元数据缓存 10 分钟。
- 合约最新价、涨跌幅和合约成交额来自 USDⓈ-M 24H 批量行情；现货成交额来自现货 24H MINI 批量行情，两者对应不同订单簿。现货仅请求交易中的市场，并在主域不可用时回退到行情专用域名。
- 点击市场后，浏览器直接查询对应交易所的公开历史资金费率接口。
- 页面每 5 分钟复用同源 Margin Pool 批量接口刷新最新借币日利率并按 `日利率 × 365` 显示年化；打开历史图时再读取逐币利率历史，并按每个实际结算周期换算为 8H 等效值或 1Y 简单年化。
- Gate REST API 不允许本地网页跨域读取，已按产品决策移除。

### Binance 接口分工

| 接口 | 用途 | 复用与缓存 |
| --- | --- | --- |
| `/fapi/v1/premiumIndex` | 当前资金费率、标记价格、下次结算时间 | Binance 首屏批量请求 |
| `/fapi/v1/ticker/24hr` | 合约最新价、24H 涨跌幅、合约成交额 | 单次合约批量请求 |
| `/fapi/v1/fundingInfo` | 非默认结算周期及费率上下限 | 缓存 10 分钟，并复用于历史费率窗口 |
| `/fapi/v1/exchangeInfo` | 合约基础资产及股票、指数、盘前等分类 | 缓存 10 分钟 |
| Alpha Token List | Alpha 分类及 Alpha 24H 成交额 | 缓存 10 分钟 |
| `/api/v3/ticker/24hr?type=MINI&symbolStatus=TRADING` | Binance 现货 24H 成交额 | 主域失败时回退行情专用域名 |
| `/fapi/v1/openInterest?symbol=...` | 单币种未平仓量 | 点击空白单元格后请求，缓存 2 分钟 |
| `/fapi/v1/fundingRate?symbol=...` | 已结算历史资金费率 | 打开历史窗口时请求 |

## 数据与凭据边界

- 资金费率历史不会落盘；点击市场时由浏览器实时请求对应交易所的公开历史接口。借币利率历史由独立 Margin Pool 采集服务保存。
- 当前市场和 Binance 未平仓量仅在当前页面内做短期内存缓存，刷新页面后消失。
- Funding Rate 网页不读取 API Key、API Secret，也不发送签名请求；Binance 签名借币利率查询只发生在独立采集服务内部。

## 验证

```bash
npm test
```

## 部署

- `deploy/funding-rate-dashboard.service`：只监听 `127.0.0.1:18765` 的受限静态文件服务。
- `deploy/nginx-global-security.conf`：关闭 Nginx 版本暴露的全局最小安全基线。
- `deploy/nginx-funding-rate-dashboard.conf`：挂载到现有 HTTPS 虚拟主机的 Nginx 反代及安全响应头。
