const config = require("./config");
const h = require("./helper");
const { pageEval } = require("./vm");
const { emitCases, emitResult, emitSuite } = require("./reporter");
const {
  attachWatch,
  installUiHooks,
  drainUiLog,
  scanPageErrors,
  classifyUiLog,
  toastMatched,
} = require("./watch");

async function switchMainTab(miniProgram, tab, label) {
  try {
    await miniProgram.reLaunch(`/pages/index/index?tab=${tab}`);
  } catch (_) {
    await h.wxEval(miniProgram, `wx.reLaunch({ url: '/pages/index/index?tab=${tab}' });`);
  }
  await h.waitPath(miniProgram, config.pages.home, 15000);
  await h.sleep(600);
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('handleTabChange', ${JSON.stringify(tab)});
      return true;
    `,
  );
  const page = await h.currentPage(miniProgram);
  const texts = await h.deep$$(page, ".tab-text");
  for (const item of texts) {
    if ((await h.safeText(item)).includes(label)) {
      await h.click(item, `底部Tab：${label}`);
      break;
    }
  }
  await h.sleep(900);
}

async function openPath(miniProgram, path) {
  const url = path.startsWith("/") ? path : `/${path}`;
  try {
    await miniProgram.navigateTo(url);
  } catch (error) {
    console.log(`>>> navigateTo ${url}：${error.message || error}`);
    await h.wxEval(miniProgram, `wx.navigateTo({ url: ${JSON.stringify(url)} });`);
  }
  await h.sleep(1400);
}

async function backOrHome(miniProgram) {
  try {
    await miniProgram.navigateBack();
    await h.sleep(400);
  } catch (_) {
    await switchMainTab(miniProgram, "home", "首页");
  }
}

async function pageHasAny(miniProgram, hints) {
  const page = await h.currentPage(miniProgram);
  for (const hint of hints) {
    if (await h.findByText(page, hint, 800)) return true;
  }
  return false;
}

function smokeCase(id, name, path, hints = []) {
  return {
    id,
    group: "頁面冒煙",
    name,
    async run(miniProgram) {
      await openPath(miniProgram, path);
      const now = await h.currentPath(miniProgram);
      if (!now.includes(path.replace(/^\//, ""))) {
        throw new Error(`未打开 ${path}，当前 ${now}`);
      }
      if (hints.length && !(await pageHasAny(miniProgram, hints))) {
        console.log(`>>> ${name} 未看到提示文案 ${hints.join("/")}，继续以无崩溃为准`);
      }
    },
    expectPath: path.replace(/^\//, ""),
    back: true,
  };
}

const CASES = [
  {
    id: "home-tab",
    group: "首頁與菜單",
    name: "打開首頁",
    async run(miniProgram) {
      await switchMainTab(miniProgram, "home", "首页");
      const ok = await pageHasAny(miniProgram, ["本月精选", "送酒到府", "首页", "更多"]);
      if (!ok) throw new Error("首页缺少主内容");
    },
    expectPath: "pages/index/index",
  },
  {
    id: "products-tab",
    group: "首頁與菜單",
    name: "打開菜單",
    async run(miniProgram) {
      await switchMainTab(miniProgram, "products", "菜单");
      const page = await h.currentPage(miniProgram);
      const plus = await h.deep$(page, ".plus-icon");
      const ok = plus || (await pageHasAny(miniProgram, ["菜单", "全部", "红酒"]));
      if (!ok) throw new Error("菜单页缺少商品或分类");
    },
    expectPath: "pages/index/index",
  },
  {
    id: "product-search",
    group: "首頁與菜單",
    name: "搜尋商品",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.productSearch);
      const page = await h.currentPage(miniProgram);
      const input = (await h.deep$(page, "input")) || (await h.deep$(page, ".search-input"));
      if (input && typeof input.input === "function") {
        await input.input("酒");
        await h.sleep(1200);
      }
    },
    expectPath: "pages/product-search/index",
    back: true,
  },
  {
    id: "ranking-open",
    group: "首頁與菜單",
    name: "打開排行榜",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.ranking);
      const ok = await pageHasAny(miniProgram, ["排行榜", "暂无排行榜数据", "Loading"]);
      if (!ok) throw new Error("排行榜页没有标题或空态");
    },
    expectPath: "pages/ranking/index",
    back: true,
  },
  {
    id: "cart-tab",
    group: "購物車與加購",
    name: "打開購物車",
    async run(miniProgram) {
      await switchMainTab(miniProgram, "cart", "购物车");
      const ok = await pageHasAny(miniProgram, ["购物车", "结算", "去结算", "空"]);
      if (!ok) console.log(">>> 购物车页未匹配到常见文案，以无崩溃为准");
    },
    expectPath: "pages/index/index",
  },
  {
    id: "add-to-cart",
    group: "購物車與加購",
    name: "加入購物車",
    async run(miniProgram) {
      await switchMainTab(miniProgram, "products", "菜单");
      const page = await h.currentPage(miniProgram);
      const plus = await h.deep$(page, ".plus-icon");
      if (!plus) throw new Error("菜单里找不到加购按钮");
      await h.click(plus, "加购");
      const addCart =
        (await h.findByText(await h.currentPage(miniProgram), "加入购物车", 5000)) ||
        (await h.deep$(await h.currentPage(miniProgram), ".add-cart"));
      if (!addCart) throw new Error("未出现加入购物车");
      await h.click(addCart, "加入购物车");
      await h.sleep(800);
    },
    ignoreToast: /已加入购物车|加入购物车/,
    back: true,
  },
  {
    id: "address-select",
    group: "加資料",
    name: "選擇收貨地址",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.addressSelect);
      const page = await h.currentPage(miniProgram);
      const item = (await h.deep$(page, ".address-item")) || (await h.findByText(page, "附近位置", 3000));
      if (item) await h.click(item, "地址项");
      const confirm = (await h.findByText(await h.currentPage(miniProgram), "确定", 3000)) || (await h.deep$(await h.currentPage(miniProgram), ".confirm-btn"));
      if (!confirm) throw new Error("找不到确定按钮");
      await h.click(confirm, "确定地址");
    },
    expectPath: "pages/address-select/index",
    expectToast: /已选择地址/,
    back: true,
  },
  {
    id: "profile-set-gender",
    group: "加資料",
    name: "修改個人性別",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.profileInfo);
      const page = await h.currentPage(miniProgram);
      const female = await h.findByText(page, "女", 4000);
      const male = await h.findByText(page, "男", 2000);
      const target = female || male;
      if (!target) throw new Error("个人信息页找不到性别选项");
      await h.click(target, "性别");
      await h.sleep(1200);
    },
    expectPath: "pages/profile-info/index",
    ignoreToast: /修改成功|保存中/,
    back: true,
  },
  {
    id: "coupon-empty-code",
    group: "加資料",
    name: "空優惠碼兌換彈窗",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.couponList);
      const page = await h.currentPage(miniProgram);
      const btn = (await h.findByText(page, "兑换", 4000)) || (await h.deep$(page, ".redeem-btn"));
      if (!btn) throw new Error("找不到兑换按钮");
      await h.click(btn, "兑换");
      await h.sleep(600);
    },
    expectPath: "pages/coupon-list/index",
    expectToast: /请输入优惠码/,
    back: true,
  },
  {
    id: "coupon-invalid-code",
    group: "加資料",
    name: "無效優惠碼兌換",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.couponList);
      const page = await h.currentPage(miniProgram);
      const input = (await h.deep$(page, "input")) || (await h.deep$(page, ".search-input"));
      if (input && typeof input.input === "function") {
        await input.input("QAINVALID");
      }
      const btn = (await h.findByText(await h.currentPage(miniProgram), "兑换", 3000)) || (await h.deep$(await h.currentPage(miniProgram), ".redeem-btn"));
      if (!btn) throw new Error("找不到兑换按钮");
      await h.click(btn, "兑换无效码");
      await h.sleep(800);
    },
    expectPath: "pages/coupon-list/index",
    ignoreToast: /兑换成功|失败|无效|不存在|请输入/,
    back: true,
  },
  {
    id: "balance-select",
    group: "加資料",
    name: "選擇儲值金額",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.balance);
      const page = await h.currentPage(miniProgram);
      const pack = (await h.deep$(page, ".package-item")) || (await h.findByText(page, "元", 3000));
      if (pack) await h.click(pack, "储值套餐");
      await h.sleep(400);
    },
    expectPath: "pages/balance/index",
    back: true,
  },
  {
    id: "wine-card-tabs",
    group: "加資料",
    name: "切換儲值卡分頁",
    async run(miniProgram) {
      await openPath(miniProgram, config.pages.wineCard);
      const page = await h.currentPage(miniProgram);
      if (!(await h.findByText(page, "储值卡", 3000)) && !(await h.findByText(page, "我的酒卡", 800))) {
        throw new Error("储值卡页缺少标题");
      }
      const buy = await h.findByText(page, "购买酒卡", 1500);
      if (buy) await h.click(buy, "购买酒卡");
    },
    expectPath: "pages/wine-card/index",
    ignoreToast: /去买卡|购买历史|收送记录/,
    back: true,
  },
  smokeCase("smoke-benefits", "權益卡頁", "pages/benefits-card/index", ["权益卡", "超值权益"]),
  smokeCase("smoke-coupon-records", "優惠記錄頁", "pages/coupon-records/index"),
  smokeCase("smoke-balance-records", "餘額明細頁", "pages/balance-records/index"),
  smokeCase("smoke-agreement-user", "會員協議頁", "pages/agreement/user"),
  smokeCase("smoke-agreement-privacy", "隱私條款頁", "pages/agreement/privacy"),
  smokeCase("smoke-language", "語言設置頁", "pages/language-settings/index", ["语言", "简体", "繁体"]),
  smokeCase("smoke-store-detail", "門店詳情頁", "pages/store-detail/index"),
  smokeCase("smoke-store-route", "門店路線頁", "pages/store-route/index"),
  smokeCase("smoke-logistics", "物流頁", "pages/logistics/index"),
  smokeCase("smoke-refund-apply", "申請退款頁", "pages/refund-apply/index"),
  smokeCase("smoke-refund-detail", "退款詳情頁", "pages/refund-detail/index"),
  smokeCase("smoke-order-verify", "待提貨頁", "pages/order-verification/index"),
  smokeCase("smoke-search-conditions", "篩選條件頁", "pages/search-conditions/index"),
  smokeCase("smoke-phone", "手機號頁", "pages/login/phone"),
  {
    id: "error-invalid-page",
    group: "異常與彈窗",
    name: "無效頁面不應崩潰",
    async run(miniProgram) {
      const before = await h.currentPath(miniProgram);
      await h.wxEval(miniProgram, "wx.navigateTo({ url: '/pages/qa-not-exist/index' });");
      await h.sleep(1500);
      const after = await h.currentPath(miniProgram);
      if (after.includes("qa-not-exist")) {
        throw new Error("无效页面被打开了，应停留或提示不存在");
      }
      console.log(`>>> 无效页面未进入栈，仍在 ${after || before}`);
    },
    ignoreToast: /页面不存在|未找到页面|失败|navigateTo/,
  },
];

function resolveCases(caseId) {
  if (!caseId) return CASES;
  const found = CASES.filter((item) => item.id === caseId);
  if (!found.length) throw new Error(`未知测试项：${caseId}`);
  return found;
}

function listCoverageCases(caseId) {
  return resolveCases(caseId).map((item) => ({
    id: item.id,
    group: item.group,
    name: item.name,
    run: "coverage-only",
    status: "idle",
  }));
}

async function runOne(miniProgram, watch, item) {
  emitResult({
    id: item.id,
    group: item.group,
    name: item.name,
    status: "running",
  });
  watch.clear();
  await drainUiLog(miniProgram);
  let status = "pass";
  let error = "";
  let path = "";
  try {
    await item.run(miniProgram);
    await h.sleep(500);
    path = await h.currentPath(miniProgram);
    const pageErrors = await scanPageErrors(miniProgram);
    const hard = watch.drain();
    const uiLog = await drainUiLog(miniProgram);
    const uiErrors = classifyUiLog(uiLog, {
      expectToast: item.expectToast,
      ignoreToast: item.ignoreToast,
    });
    if (item.expectToast && !toastMatched(uiLog, item.expectToast)) {
      status = "fail";
      error = `未出现预期弹窗：${item.expectToast}`;
    } else if (item.expectPath && !path.includes(item.expectPath)) {
      status = "fail";
      error = `未进入 ${item.expectPath}，当前 ${path}`;
    } else if (pageErrors.length || hard.length || uiErrors.length) {
      status = "fail";
      error = [...pageErrors, ...hard, ...uiErrors].join("；").slice(0, 240);
    }
  } catch (err) {
    status = "fail";
    error = err.message || String(err);
    try {
      path = await h.currentPath(miniProgram);
    } catch (_) {
      path = "";
    }
  }
  emitResult({
    id: item.id,
    group: item.group,
    name: item.name,
    status,
    path,
    error,
  });
  if (item.back) {
    try {
      await backOrHome(miniProgram);
    } catch (err) {
      console.log(`>>> 返回失败：${err.message || err}`);
    }
  }
  return status === "pass";
}

async function runCoverageSuite(miniProgram, options = {}) {
  const cases = resolveCases(options.caseId);
  console.log(options.caseId ? `>>> 开始覆盖测试：${cases[0].name}` : ">>> 开始页面/加资料/异常覆盖测试");
  emitCases(listCoverageCases(options.caseId));
  await installUiHooks(miniProgram);
  const watch = attachWatch(miniProgram);
  let passed = 0;
  let failed = 0;
  for (const item of cases) {
    const ok = await runOne(miniProgram, watch, item);
    if (ok) passed += 1;
    else failed += 1;
  }
  const summary = { passed, failed, total: cases.length };
  emitSuite(summary);
  console.log(`>>> 覆盖测试结果：通过 ${passed} / 失败 ${failed} / 共 ${cases.length}`);
  return summary;
}

module.exports = {
  listCoverageCases,
  runCoverageSuite,
};
