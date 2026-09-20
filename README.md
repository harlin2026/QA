# QA

aChill Club 微信小程序頁面流程自動化（`miniprogram-automator`）。

架構說明見 [docs/architecture.md](docs/architecture.md)。

## 控制台 UI

先開微信開發者工具並編譯小程序，再啟動控制台：

```bash
npm start
```

瀏覽器打開 http://127.0.0.1:3780 ，選擇要測的線路後點「開始測試」。日誌會即時出現在右側控制台，也會同步印在啟動 UI 的終端機裡。

選擇 **完整流程** 或 **只測會員中心** 時，中間欄會列出「我的 / 訂單 / 服務 / 會員中心」各功能測試項。每項跑完會標記 **通過** 或 **失敗**（頁面報錯、跳轉異常、JS 異常都會記失敗）。

命令列也可指定線路：

```bash
node run.js --route=settlement
node run.js --route=payment
node run.js --route=member
```

`npm test` 預設跑完整流程（`member`）。
