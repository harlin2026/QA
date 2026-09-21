const ROUTES = [
  {
    id: "login",
    label: "登入到首頁",
    through: "login",
    summary: "清登入態、選 QA、微信一鍵登入到首頁",
  },
  {
    id: "store",
    label: "到選店",
    through: "store",
    summary: "登入後進入澳門直營店菜單",
  },
  {
    id: "settlement",
    label: "到結算頁",
    through: "settlement",
    summary: "加購 2–3 件並進入結算（不支付）",
  },
  {
    id: "payment",
    label: "到支付成功",
    through: "payment",
    summary: "結算下單，進入支付成功頁",
  },
  {
    id: "orders",
    label: "到訂單",
    through: "orders",
    summary: "支付後查看訂單詳情與列表",
  },
  {
    id: "member",
    label: "完整流程",
    through: "member",
    summary: "登入到會員中心，並逐項測「我的」與會員功能",
    default: true,
  },
  {
    id: "payment-only",
    label: "只測支付",
    only: "payment",
    summary: "從目前會話開始，需已在結算頁",
    isolated: true,
  },
  {
    id: "orders-only",
    label: "只測訂單",
    only: "orders",
    summary: "從目前會話開始，需已登入",
    isolated: true,
  },
  {
    id: "member-only",
    label: "只測會員中心",
    only: "member",
    summary: "從目前會話開始，逐項測「我的」與會員中心功能",
    isolated: true,
  },
  {
    id: "coverage-only",
    label: "只測覆蓋項",
    only: "coverage",
    summary: "從目前會話開始，測未覆蓋頁面、加資料與報錯彈窗",
    isolated: true,
  },
];

function resolveRoute(id) {
  const key = String(id || "").trim() || "member";
  const found = ROUTES.find((item) => item.id === key);
  if (found) return found;
  throw new Error(`未知线路：${key}。可用：${ROUTES.map((item) => item.id).join(", ")}`);
}

module.exports = {
  ROUTES,
  resolveRoute,
};
