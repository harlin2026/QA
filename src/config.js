const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(root, "config.json");

const DEFAULT_HINTS = [
  "aChill Club澳门直营店",
  "澳门直营店",
  "澳門直營店",
  "澳门直营",
  "澳门",
  "澳門",
];

const DEFAULT_PAGES = {
  login: "pages/login/login",
  home: "pages/index/index",
  storeList: "pages/store-list/index",
  storeSearch: "pages/store-search/index",
  settlement: "pages/settlement/index",
  paymentSuccess: "pages/payment-success/index",
  orderList: "pages/order-list/index",
  orderDetail: "pages/order-detail/index",
  memberCenter: "pages/member-center/index",
  profileInfo: "pages/profile-info/index",
  couponList: "pages/coupon-list/index",
  pointsRedeem: "pages/points-redeem/index",
  settings: "pages/settings/index",
  benefitsCard: "pages/benefits-card/index",
  productDetails: "pages/product-details/index",
  addressSelect: "pages/address-select/index",
  productSearch: "pages/product-search/index",
  ranking: "pages/ranking/index",
  wineCard: "pages/wine-card/index",
  couponRecords: "pages/coupon-records/index",
  balance: "pages/balance/index",
  balanceRecords: "pages/balance-records/index",
};

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    return {};
  }
}

function asList(value, fallback) {
  if (Array.isArray(value) && value.length) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  }
  return fallback.slice();
}

function loadConfig() {
  const raw = readRaw();
  const tools = raw.tools || {};
  const params = raw.params || {};
  return {
    root,
    cliPath: tools.cliPath || raw.cliPath || raw.dev_tool_path || "",
    projectPath: tools.projectPath || raw.projectPath || raw.project_path || "",
    testPort: Number(tools.testPort || raw.testPort || raw.test_port || 9420),
    pythonPath: String(tools.pythonPath || raw.pythonPath || ""),
    uiPort: Number(tools.uiPort || raw.uiPort || process.env.QA_UI_PORT || 3780),
    qaApi: params.qaApi || raw.qaApi || "https://peterson-gw-qa.weprogram.site",
    qaPhone: String(params.qaPhone || raw.qaPhone || "13800138000"),
    preferredStore: params.preferredStore || raw.preferredStore || "aChill Club澳门直营店",
    preferredHints: asList(params.preferredHints || raw.preferredHints, DEFAULT_HINTS),
    finishDelay: Number(params.finishDelay || raw.finishDelay || raw.finish_delay || 15) * 1000,
    pages: { ...DEFAULT_PAGES, ...(raw.pages || {}) },
  };
}

function publicConfig() {
  const current = loadConfig();
  return {
    tools: {
      cliPath: current.cliPath,
      projectPath: current.projectPath,
      testPort: current.testPort,
      pythonPath: current.pythonPath,
      uiPort: current.uiPort,
    },
    params: {
      qaApi: current.qaApi,
      qaPhone: current.qaPhone,
      preferredStore: current.preferredStore,
      preferredHints: current.preferredHints,
      finishDelay: current.finishDelay / 1000,
    },
  };
}

function saveConfig(incoming = {}) {
  const current = publicConfig();
  const next = {
    tools: { ...current.tools, ...(incoming.tools || {}) },
    params: { ...current.params, ...(incoming.params || {}) },
  };
  next.params.preferredHints = asList(next.params.preferredHints, current.params.preferredHints);
  next.tools.testPort = Number(next.tools.testPort || 9420);
  next.tools.uiPort = Number(next.tools.uiPort || 3780);
  next.params.finishDelay = Number(next.params.finishDelay || 15);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return publicConfig();
}

const snapshot = loadConfig();
snapshot.loadConfig = loadConfig;
snapshot.publicConfig = publicConfig;
snapshot.saveConfig = saveConfig;

module.exports = snapshot;
