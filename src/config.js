const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const raw = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));

module.exports = {
  root,
  cliPath: raw.cliPath || raw.dev_tool_path,
  projectPath: raw.projectPath || raw.project_path,
  testPort: Number(raw.test_port || 9420),
  finishDelay: Number(raw.finish_delay || 15) * 1000,
  qaApi: "https://peterson-gw-qa.weprogram.site",
  qaPhone: "13800138000",
  preferredStore: "aChill Club澳门直营店",
  preferredHints: ["aChill Club澳门直营店", "澳门直营店", "澳門直營店", "澳门直营", "澳门", "澳門"],
  pages: {
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
  },
};
