const config = require("./config");
const h = require("./helper");
const { pageEval } = require("./vm");
const { emitCases, emitResult, emitSuite } = require("./reporter");

const ERROR_TEXT = /页面不存在|页面错误|出错了|出错啦|系统错误|渲染错误|TypeError|Cannot read|undefined is not|未找到页面/;
const HARD_ERROR = /渲染层错误|Uncaught|TypeError|ReferenceError|未找到页面|页面不存在/;

function stringify(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.message) return String(value.message);
  if (value.text) return String(value.text);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function attachWatch(miniProgram) {
  const bucket = [];
  const onException = (error) => {
    const msg = stringify(error);
    if (!msg) return;
    bucket.push(msg);
    console.log(`>>> 捕获异常：${msg.slice(0, 240)}`);
  };
  const onConsole = (msg) => {
    const text = stringify(msg);
    if (HARD_ERROR.test(text) || (msg && msg.type === "error" && HARD_ERROR.test(text))) {
      bucket.push(text);
    }
  };
  miniProgram.on("exception", onException);
  miniProgram.on("console", onConsole);
  return {
    clear() {
      bucket.length = 0;
    },
    drain() {
      const items = bucket.slice();
      bucket.length = 0;
      return items.filter((item) => HARD_ERROR.test(item) || ERROR_TEXT.test(item));
    },
  };
}

async function clickText(miniProgram, text, label = text) {
  const page = await h.currentPage(miniProgram);
  const el =
    (await h.findByText(page, text, 4000)) ||
    (await h.deep$(page, `.${label}`));
  if (!el) throw new Error(`找不到「${text}」`);
  await h.click(el, label);
}

async function scanPageErrors(miniProgram) {
  try {
    const page = await h.currentPage(miniProgram);
    const nodes = await h.deep$$(page, "text");
    const texts = [];
    for (const node of nodes.slice(0, 40)) {
      const value = await h.safeText(node);
      if (value) texts.push(value);
    }
    const blob = texts.join(" ");
    if (ERROR_TEXT.test(blob)) return [blob.slice(0, 180)];
  } catch (error) {
    return [error.message || String(error)];
  }
  return [];
}

async function ensureProfileTab(miniProgram) {
  try {
    await miniProgram.reLaunch("/pages/index/index?tab=profile");
  } catch (error) {
    await h.wxEval(miniProgram, "wx.reLaunch({ url: '/pages/index/index?tab=profile' });");
  }
  await h.waitPath(miniProgram, config.pages.home, 15000);
  await h.sleep(800);
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('handleTabChange', 'profile');
      return true;
    `,
  );
  const page = await h.currentPage(miniProgram);
  const texts = await h.deep$$(page, ".tab-text");
  for (const item of texts) {
    if ((await h.safeText(item)).includes("我的")) {
      await h.click(item, "底部Tab：我的");
      break;
    }
  }
  await h.sleep(900);
}

async function backToProfile(miniProgram) {
  const path = await h.currentPath(miniProgram);
  if (path.includes(config.pages.home)) {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        ctx.callFn('handleTabChange', 'profile');
        return true;
      `,
    );
    await h.sleep(500);
    return;
  }
  try {
    await miniProgram.navigateBack();
  } catch (_) {
    await ensureProfileTab(miniProgram);
    return;
  }
  const stayed = await h.waitUntil(async () => {
    const now = await h.currentPath(miniProgram);
    return now.includes(config.pages.home) || !now.includes(path);
  }, 6000, 300);
  if (!stayed || !(await h.currentPath(miniProgram)).includes(config.pages.home)) {
    await ensureProfileTab(miniProgram);
  } else {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        ctx.callFn('handleTabChange', 'profile');
        return true;
      `,
    );
    await h.sleep(400);
  }
}

async function navigateToMemberCenter(miniProgram) {
  try {
    await miniProgram.navigateTo("/pages/member-center/index");
  } catch (error) {
    console.log(`>>> navigateTo 会员中心：${error.message || error}`);
    await h.wxEval(miniProgram, "wx.navigateTo({ url: '/pages/member-center/index' });");
  }
}

async function openMemberCenterPage(miniProgram) {
  await ensureProfileTab(miniProgram);
  const page = await h.currentPage(miniProgram);
  const card =
    (await h.deep$(page, ".member-top")) ||
    (await h.deep$(page, ".member-arrow")) ||
    (await h.deep$(page, ".member-title")) ||
    (await h.deep$(page, "profile-member-card")) ||
    (await h.findByText(page, "白银卡", 1500)) ||
    (await h.findByText(page, "黄金卡", 800));
  if (card) await h.click(card, "会员卡顶部");

  let reached = await h.waitPath(miniProgram, config.pages.memberCenter, 5000);
  if (!reached) {
    console.log(">>> 点击会员卡未跳转，改用 navigateTo");
    await navigateToMemberCenter(miniProgram);
    reached = await h.waitPath(miniProgram, config.pages.memberCenter, 10000);
  }
  if (!reached) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("未进入会员中心");
  }
}

const CASES = [
  {
    id: "profile-home",
    group: "我的",
    name: "進入「我的」頁",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      const page = await h.currentPage(miniProgram);
      const ok =
        (await h.findByText(page, "我的订单", 4000)) ||
        (await h.findByText(page, "会员余额", 2000));
      if (!ok) throw new Error("「我的」页缺少订单或会员信息");
    },
    expectPath: "pages/index/index",
  },
  {
    id: "profile-info",
    group: "我的",
    name: "個人信息",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      const page = await h.currentPage(miniProgram);
      const el =
        (await h.deep$(page, ".login-text")) ||
        (await h.findByText(page, "Chillax", 2000)) ||
        (await h.deep$(page, ".user-left"));
      if (!el) throw new Error("找不到头像/昵称入口");
      await h.click(el, "个人信息");
      const reached = await h.waitPath(miniProgram, config.pages.profileInfo, 8000);
      if (!reached) {
        await h.wxEval(miniProgram, "wx.navigateTo({ url: '/pages/profile-info/index' });");
        if (!(await h.waitPath(miniProgram, config.pages.profileInfo, 8000))) {
          throw new Error("未进入个人信息页");
        }
      }
    },
    expectPath: "pages/profile-info/index",
    back: true,
  },
  {
    id: "profile-qrcode",
    group: "我的",
    name: "會員碼彈窗",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      const page = await h.currentPage(miniProgram);
      const btn = (await h.deep$(page, ".scan-btn")) || (await h.deep$(page, ".scan-icon"));
      if (!btn) throw new Error("找不到会员码按钮");
      await h.click(btn, "会员码");
      await h.sleep(800);
      const now = await h.currentPage(miniProgram);
      const popup =
        (await h.deep$(now, ".code-card")) ||
        (await h.findByText(now, "永久有效", 1500)) ||
        (await h.findByText(now, "余额", 800));
      if (!popup) throw new Error("点击会员码后没有弹出会员码");
    },
    expectPath: "pages/index/index",
    back: true,
  },
  {
    id: "profile-balance",
    group: "我的",
    name: "會員餘額",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "会员余额");
      await h.sleep(600);
    },
    expectPath: "pages/index/index",
  },
  {
    id: "profile-points",
    group: "我的",
    name: "積分",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "积分");
      const reached = await h.waitPath(miniProgram, config.pages.pointsRedeem, 8000);
      if (!reached) {
        await h.wxEval(miniProgram, "wx.navigateTo({ url: '/pages/points-redeem/index' });");
        if (!(await h.waitPath(miniProgram, config.pages.pointsRedeem, 8000))) {
          throw new Error("未进入积分页");
        }
      }
    },
    expectPath: "pages/points-redeem/index",
    back: true,
  },
  {
    id: "profile-coupons",
    group: "我的",
    name: "優惠券",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "优惠券");
      const reached = await h.waitPath(miniProgram, config.pages.couponList, 8000);
      if (!reached) {
        await h.wxEval(miniProgram, "wx.navigateTo({ url: '/pages/coupon-list/index' });");
        if (!(await h.waitPath(miniProgram, config.pages.couponList, 8000))) {
          throw new Error("未进入优惠券页");
        }
      }
    },
    expectPath: "pages/coupon-list/index",
    back: true,
  },
  {
    id: "orders-all",
    group: "我的訂單",
    name: "查看全部訂單",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "查看全部订单");
      if (!(await h.waitPath(miniProgram, config.pages.orderList, 8000))) {
        throw new Error("未进入订单列表");
      }
    },
    expectPath: "pages/order-list/index",
    back: true,
  },
  {
    id: "orders-pay",
    group: "我的訂單",
    name: "待付款",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "待付款");
      if (!(await h.waitPath(miniProgram, config.pages.orderList, 8000))) {
        throw new Error("未进入待付款订单");
      }
    },
    expectPath: "pages/order-list/index",
    back: true,
  },
  {
    id: "orders-send",
    group: "我的訂單",
    name: "待發貨",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "待发货");
      if (!(await h.waitPath(miniProgram, config.pages.orderList, 8000))) {
        throw new Error("未进入待发货订单");
      }
    },
    expectPath: "pages/order-list/index",
    back: true,
  },
  {
    id: "orders-receive",
    group: "我的訂單",
    name: "待收貨/提貨",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "待收货/提货");
      if (!(await h.waitPath(miniProgram, config.pages.orderList, 8000))) {
        throw new Error("未进入待收货/提货订单");
      }
    },
    expectPath: "pages/order-list/index",
    back: true,
  },
  {
    id: "orders-refund",
    group: "我的訂單",
    name: "退款/售後",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "退款/售后");
      if (!(await h.waitPath(miniProgram, config.pages.orderList, 8000))) {
        throw new Error("未进入退款/售后订单");
      }
    },
    expectPath: "pages/order-list/index",
    back: true,
  },
  {
    id: "service-address",
    group: "我的服務",
    name: "收貨地址",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      const before = await h.currentPath(miniProgram);
      await clickText(miniProgram, "收货地址");
      await h.sleep(800);
      const after = await h.currentPath(miniProgram);
      if (after.includes(config.pages.addressSelect)) return;
      if (after !== before && !after.includes(config.pages.home)) {
        throw new Error(`收货地址跳到异常页：${after}`);
      }
    },
  },
  {
    id: "service-settings",
    group: "我的服務",
    name: "設置",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "设置");
      if (!(await h.waitPath(miniProgram, config.pages.settings, 8000))) {
        throw new Error("未进入设置页");
      }
      const page = await h.currentPage(miniProgram);
      const ok =
        (await h.findByText(page, "个人信息", 3000)) ||
        (await h.findByText(page, "退出登录", 2000));
      if (!ok) throw new Error("设置页缺少个人信息或退出登录");
    },
    expectPath: "pages/settings/index",
    back: true,
  },
  {
    id: "service-cs",
    group: "我的服務",
    name: "在線客服",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "在线客服");
      await h.sleep(600);
    },
    expectPath: "pages/index/index",
  },
  {
    id: "service-invoice",
    group: "我的服務",
    name: "開發票",
    async run(miniProgram) {
      await ensureProfileTab(miniProgram);
      await clickText(miniProgram, "开发票");
      await h.sleep(600);
    },
    expectPath: "pages/index/index",
  },
  {
    id: "member-open",
    group: "會員中心",
    name: "打開會員中心",
    async run(miniProgram) {
      await openMemberCenterPage(miniProgram);
      const page = await h.currentPage(miniProgram);
      const ok =
        (await h.findByText(page, "会员权益", 4000)) ||
        (await h.findByText(page, "成长任务", 2000)) ||
        (await h.findByText(page, "更多个性化推荐", 2000));
      if (!ok) throw new Error("会员中心打开后缺少权益、成长任务或推荐");
    },
    expectPath: "pages/member-center/index",
  },
  {
    id: "member-benefits",
    group: "會員中心",
    name: "會員權益",
    async run(miniProgram) {
      if (!(await h.currentPath(miniProgram)).includes(config.pages.memberCenter)) {
        await openMemberCenterPage(miniProgram);
      }
      const page = await h.currentPage(miniProgram);
      if (!(await h.findByText(page, "会员权益", 3000))) {
        throw new Error("未看到会员权益区块");
      }
      const labels = ["生日特权", "新品尝鲜", "专属管家", "专属客服", "黑钻管家", "会员积分", "双倍积分"];
      let found = 0;
      for (const label of labels) {
        if (await h.findByText(page, label, 400)) found += 1;
      }
      if (found < 3) throw new Error("会员权益条目不足，当前页未展示完整权益");
    },
    expectPath: "pages/member-center/index",
  },
  {
    id: "member-tasks",
    group: "會員中心",
    name: "成長任務",
    async run(miniProgram) {
      if (!(await h.currentPath(miniProgram)).includes(config.pages.memberCenter)) {
        await openMemberCenterPage(miniProgram);
      }
      const page = await h.currentPage(miniProgram);
      if (!(await h.findByText(page, "成长任务", 3000))) {
        throw new Error("未看到成长任务区块");
      }
      const hasProfile = await h.findByText(page, "完善信息", 800);
      const hasBuy = await h.findByText(page, "购买商品", 800);
      if (!hasProfile && !hasBuy) throw new Error("成长任务列表是空的");
      if (hasBuy) {
        const rows = await h.deep$$(page, ".task-item");
        let clicked = false;
        for (const row of rows) {
          if ((await h.safeText(row)).includes("购买商品")) {
            const btn = (await h.first(row, ".task-btn")) || row;
            await h.click(btn, "购买商品-去完成");
            clicked = true;
            break;
          }
        }
        if (!clicked) await clickText(miniProgram, "购买商品");
        if (!(await h.waitPath(miniProgram, config.pages.benefitsCard, 8000))) {
          throw new Error("购买商品未进入权益卡页");
        }
      }
    },
    expectPath: "pages/benefits-card/index",
    back: true,
  },
  {
    id: "member-recommend",
    group: "會員中心",
    name: "個性化推薦",
    async run(miniProgram) {
      if (!(await h.currentPath(miniProgram)).includes(config.pages.memberCenter)) {
        await openMemberCenterPage(miniProgram);
      }
      const page = await h.currentPage(miniProgram);
      const title = await h.findByText(page, "更多个性化推荐", 3000);
      if (!title) throw new Error("未看到个性化推荐");
      const cards = await h.deep$$(page, ".recommend-card");
      if (!cards.length) {
        console.log(">>> 个性化推荐目前没有商品卡片，按页面正常展示记通过");
        return;
      }
      await h.click(cards[0], "推荐商品");
      const reached = await h.waitPath(miniProgram, config.pages.productDetails, 8000);
      if (!reached) throw new Error("点击推荐商品未进入商品详情");
    },
    back: true,
  },
];

function resolveCases(caseId) {
  if (!caseId) return CASES;
  const found = CASES.filter((item) => item.id === caseId);
  if (!found.length) throw new Error(`未知测试项：${caseId}`);
  return found;
}

function listMemberCases(caseId) {
  return resolveCases(caseId).map((item) => ({
    id: item.id,
    group: item.group,
    name: item.name,
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
  let status = "pass";
  let error = "";
  let path = "";
  try {
    await item.run(miniProgram);
    await h.sleep(500);
    path = await h.currentPath(miniProgram);
    const pageErrors = await scanPageErrors(miniProgram);
    const hard = watch.drain();
    if (item.expectPath && !path.includes(item.expectPath)) {
      status = "fail";
      error = `未进入 ${item.expectPath}，当前 ${path}`;
    } else if (pageErrors.length || hard.length) {
      status = "fail";
      error = [...pageErrors, ...hard].join("；").slice(0, 240);
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
      await backToProfile(miniProgram);
    } catch (err) {
      console.log(`>>> 返回我的失败：${err.message || err}`);
      await ensureProfileTab(miniProgram);
    }
  }
  return status === "pass";
}

async function runMemberSuite(miniProgram, options = {}) {
  const cases = resolveCases(options.caseId);
  console.log(options.caseId ? `>>> 开始会员功能单项测试：${cases[0].name}` : ">>> 开始会员功能逐项测试");
  emitCases(listMemberCases(options.caseId));
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
  console.log(`>>> 会员功能结果：通过 ${passed} / 失败 ${failed} / 共 ${cases.length}`);
  return summary;
}

module.exports = {
  listMemberCases,
  runMemberSuite,
  openMemberCenterPage,
};
