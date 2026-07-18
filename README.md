# Funding Rate Dashboard

五家交易所的纯前端永续合约资金费率看板，独立于套利策略、账户和下单服务运行。

## 功能

- 支持 Binance、OKX、Bybit、Bitget 和 Hyperliquid
- 支持按交易所、币种、未平仓额、日成交额、资金费率、下次资金费率、上下限和结算周期排序或筛选
- 资金费率可在 8H 等效费率和 1Y 简单年化之间切换
- 点击任意市场可查看公开 API 返回的最近 200 条历史资金费率
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
- Binance 先用三个批量接口展示基础行情，再渐进补充资产标签和逐合约未平仓量；分类元数据缓存 10 分钟。
- 点击市场后，浏览器直接查询对应交易所的公开历史资金费率接口。
- 可关联币种会额外查询同源的 Margin Pool 只读接口；借币日利率按当前页面周期换算为 8H 等效值或 1Y 简单年化。
- Gate REST API 不允许本地网页跨域读取，已按产品决策移除。

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
