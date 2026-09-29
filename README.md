# Awan Prediction AI

A GitHub Pages/PWA prototype for normal forex pairs.

## Important data note
The chart is designed to use the same candle timeframes (1m, 5m, 15m, 30m, 1h, 4h, 1D) and live OHLC behavior as a normal forex chart, but it **does not claim to use Quotex's proprietary price feed**. Different providers can have small price/candle differences.

## Setup
1. Create a Twelve Data account and obtain an API key.
2. Put this folder in a GitHub repository.
3. Enable GitHub Pages from the repository's Pages settings, using the main branch/root.
4. Open the site and tap the gear icon.
5. Paste your API key. The key is stored locally in that browser.
6. Select EUR/USD or another normal forex pair and timeframe.

Twelve Data's `/time_series` endpoint supports forex symbols such as `EUR/USD` and intraday intervals including 1min, 5min, 15min, 30min, 1h, 4h and 1day. Its WebSocket can stream price updates for symbols including EUR/USD and USD/JPY. Provider plan/usage limits apply.

## Prediction engine
The prototype combines:
- EMA(9)/EMA(21) trend
- RSI(14)
- ATR(14)
- engulfing/rejection/doji and multi-candle patterns
- recent range position
- a two-horizon scoring model

It reports a confidence score, not a guaranteed win rate. The Backtest panel uses historical candles to show observed performance on the loaded sample.

## Android
Because this is a PWA, it can be installed from a supported browser. For a standalone APK, the same web project can later be wrapped with Capacitor or another Android WebView/TWA workflow.


### Forecast candle overlay
The chart now draws up to two light-colored forecast candles ahead of the latest real candle. Light green means the model predicts UP; light red means DOWN. These are predictions only and are not live/actual future market candles.


## New version: locked 1-minute signals + history

- Predictions are calculated from completed candles and locked for the active candle instead of recalculating on every tick.
- A new prediction is created when a new candle begins.
- Trade History stores signal direction, confidence, time, and WIN/LOSS/PENDING status in the browser.
- Pending results can be recorded manually, and the feed can automatically resolve them from the completed candle direction.
- Added live forex and Quotex-style OTC pair lists.
- Added a TradingView button that opens https://www.tradingview.com/ in a new tab.

## Data-source guidance

**Normal/live forex:** Twelve Data is the simplest fit for this GitHub Pages prototype. Its API provides forex-pair listings and its WebSocket can stream instruments such as EUR/USD and USD/JPY. See the official docs at https://twelvedata.com/docs and https://support.twelvedata.com/en/articles/5620516-how-to-stream-the-data.

**Quotex/OTC:** Quotex does not publish an official developer API. Third-party services and unofficial wrappers exist, but they are not the same as an official broker integration. For exact candle matching, the signal engine must consume the same venue-specific OTC feed that the trading screen uses. A server-side proxy is preferable because private credentials should not be embedded in a public GitHub Pages client.

**TradingView:** TradingView's charting libraries do not themselves supply market data; a datafeed must be connected. TradingView's public widgets use TradingView-provided data, so simply adding a TradingView URL does not make its candles identical to Quotex. The app therefore provides a TradingView link rather than pretending it is a Quotex data API.

**Important:** No feed choice can honestly guarantee 100% prediction accuracy. The app records observed results so performance can be tested on the actual feed.
