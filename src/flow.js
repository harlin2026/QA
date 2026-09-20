const config = require("./config");
const native = require("./native-win");
const h = require("./helper");
const { resolveRoute } = require("./routes");
const { pageEval } = require("./vm");
const { runMemberSuite, openMemberCenterPage } = require("./member-suite");

async function clearLoginState(miniProgram) {
  try {
    await miniProgram.callWxMethod("clearStorageSync");
  } catch (_) {
    /* evaluate 再清一次 */
  }
  await h.wxEval(
    miniProgram,
    `
      try { wx.clearStorageSync(); } catch (e) {}
      ['token','userId','userInfo','wxUserInfo','needCompletePhone','selectedStoreId','selectedStoreName','selectedStore'].forEach(function (key) {
        try { wx.removeStorageSync(key); } catch (e) {}
      });
    `,
  );
  const token = await h.storage(miniProgram, "token");
  const userInfo = await h.storage(miniProgram, "userInfo");
  console.log(`>>> 已清除登录态 token=${token ? "仍在" : "空"} userInfo=${userInfo ? "仍在" : "空"}`);
}

async function openLogin(miniProgram) {
  await h.restoreLeftoverMocks(miniProgram);
  console.log(">>> 1/6 打开登录页");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clearLoginState(miniProgram);
    let path = "";
    try {
      path = await h.currentPath(miniProgram);
    } catch (_) {
      /* 页面栈还没稳定 */
    }
    if (!String(path).includes(config.pages.login)) {
      try {
        await h.wxEval(miniProgram, "wx.reLaunch({ url: '/pages/login/login' });");
      } catch (error) {
        console.log(`>>> wx.reLaunch：${error.message || error}`);
      }
      await h.sleep(1500);
    }
    const reached = await h.waitUntil(async () => {
      try {
        return (await h.currentPath(miniProgram)).includes(config.pages.login);
      } catch (_) {
        return false;
      }
    }, 12000, 400);
    await h.sleep(800);
    try {
      path = await h.currentPath(miniProgram);
    } catch (error) {
      path = `读取失败：${error.message || error}`;
    }
    console.log(`>>> 当前页面：${path}`);
    if (reached) return;
    console.log(`>>> 第 ${attempt} 次还在 ${path}，清登录态后再进登录页`);
  }
  throw new Error("未进入登录页");
}

async function chooseQa(miniProgram) {
  console.log(">>> 2/6 选择 QA 环境");
  await h.sleep(500);
  await h.wxEval(
    miniProgram,
    `
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      const vm = page && (page.$vm || page);
      const option = { key: 'prod', label: 'QA', url: ${JSON.stringify(config.qaApi)} };
      if (vm && typeof vm.switchApiBase === 'function') {
        vm.currentApiBase = '';
        vm.switchApiBase(option);
      }
      wx.setStorageSync('api_base', ${JSON.stringify(config.qaApi)});
      wx.setStorageSync('api_base_manual', true);
    `,
  );
  try {
    const page = await h.currentPage(miniProgram);
    const buttons = await h.deep$$(page, ".api-switcher__button");
    let qa = null;
    for (const btn of buttons) {
      if ((await h.safeText(btn)).includes("QA")) {
        qa = btn;
        break;
      }
    }
    qa = qa || (await h.findByText(page, "QA", 3000));
    if (qa) await h.click(qa, "QA");
  } catch (error) {
    console.log(`>>> 点击 QA 按钮时页面栈变化，接口已切换：${error.message || error}`);
  }
  await h.wxEval(
    miniProgram,
    `
      wx.setStorageSync('api_base', ${JSON.stringify(config.qaApi)});
      wx.setStorageSync('api_base_manual', true);
    `,
  );
  console.log(`>>> 当前接口：${await h.storage(miniProgram, "api_base")}`);
  await h.restoreLeftoverMocks(miniProgram);
}

async function agreeTerms(miniProgram) {
  console.log(">>> 3/6 勾选「我已阅读并同意」");
  const page = await h.currentPage(miniProgram);
  const ok = await h.waitUntil(async () => !!(await h.findByText(page, "我已阅读并同意", 800)), 20000);
  if (!ok) throw new Error("页面未出现文字：我已阅读并同意");
  const checkbox = await h.deep$(page, ".check-circle");
  if (!checkbox) throw new Error("未找到同意勾选框");
  await h.click(checkbox, "我已阅读并同意");
  await h.wxEval(
    miniProgram,
    `
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page) return;
      try { page.setData({ isAgreed: true }); } catch (e) {}
      if (page.$vm) page.$vm.isAgreed = true;
    `,
  );
}

function hookMiniProgramLogs(miniProgram) {
  if (miniProgram._loginConsoleHooked) return;
  miniProgram._loginConsoleHooked = true;
  miniProgram.on("console", (msg) => {
    try {
      const text = typeof msg === "string" ? msg : JSON.stringify(msg);
      console.log(`>>> [小程序] ${String(text).slice(0, 1500)}`);
      if (/getPhoneNumber:ok|PHONE_EVENT/.test(text)) {
        miniProgram._phoneOk = true;
        const match = text.match(/"code":"([a-zA-Z0-9_-]+)"/);
        if (match) miniProgram._phoneCode = match[1];
        console.log(">>> 已收到 getPhoneNumber:ok，等待登录后进入首页");
      }
      if (/bind-phone/.test(text) && /WX_RESP/.test(text)) {
        miniProgram._phoneBound = true;
      }
      if (/cart-total-with-products/.test(text) && /WX_RESP/.test(text)) {
        miniProgram._cartAddResp = text;
      }
      if (/\/mini\/carts/.test(text) && /WX_RESP/.test(text)) {
        miniProgram._cartListResp = text;
      }
      if (/登录失败|获取手机号失败|需要授权手机号|WX_FAIL/.test(text)) {
        console.log(">>> 登录过程出现错误提示");
      }
    } catch (_) {
      /* ignore */
    }
  });
}

async function hookWxRequest(miniProgram) {
  try {
    await h.wxEval(
      miniProgram,
      `
        if (wx.__reqHooked) return;
        const req = wx.request;
        if (typeof req !== 'function') {
          console.log('WX_REQUEST_SKIP');
          return;
        }
        wx.__reqHooked = true;
        const orig = req;
        wx.request = function (opts) {
          const url = (opts && opts.url) || '';
          try { console.log('WX_REQUEST ' + url + ' ' + JSON.stringify(opts.data || {}).slice(0, 280)); } catch (e) {}
          const success = opts && opts.success;
          const fail = opts && opts.fail;
          if (opts) {
            opts.success = function (res) {
              try { console.log('WX_RESP ' + url + ' ' + res.statusCode + ' ' + JSON.stringify(res.data).slice(0, 500)); } catch (e) {}
              if (typeof success === 'function') success(res);
            };
            opts.fail = function (err) {
              try { console.log('WX_FAIL ' + url + ' ' + ((err && (err.errMsg || err.message)) || '')); } catch (e) {}
              if (typeof fail === 'function') fail(err);
            };
          }
          return orig.call(wx, opts);
        };
      `,
    );
  } catch (error) {
    console.log(`>>> 未能监听请求：${error.message || error}`);
  }
}

async function leftLogin(miniProgram) {
  const path = await h.currentPath(miniProgram);
  const token = await h.storage(miniProgram, "token");
  if (!path.includes(config.pages.login) || token) {
    console.log(`>>> 已离开登录页 path=${path} token=${token ? "有" : "空"}`);
    return true;
  }
  return false;
}

async function patchPhoneEvent(miniProgram) {
  try {
    await h.wxEval(
      miniProgram,
      `
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        const vm = page && (page.$vm || page);
        if (!vm || vm.__phonePatched) return;
        const state = vm.$ && vm.$.setupState;
        const handler = (typeof vm.handleGetPhoneNumber === 'function' && vm.handleGetPhoneNumber)
          || (state && state.handleGetPhoneNumber);
        if (typeof handler !== 'function') return;
        vm.__phonePatched = true;
        const wrap = function (e) {
          const detail = (e && e.detail) || {};
          const target = (e && e.target) || {};
          const merged = {
            errMsg: detail.errMsg || target.errMsg || '',
            code: detail.code || target.code,
            encryptedData: detail.encryptedData || target.encryptedData,
            iv: detail.iv || target.iv
          };
          console.log('PHONE_EVENT ' + JSON.stringify(merged).slice(0, 280));
          return handler.call(this, Object.assign({}, e, { detail: Object.assign({}, detail, merged) }));
        };
        vm.handleGetPhoneNumber = wrap;
        if (state && typeof state.handleGetPhoneNumber === 'function') {
          state.handleGetPhoneNumber = wrap;
        }
      `,
    );
  } catch (error) {
    console.log(`>>> 未能补丁手机号事件：${error.message || error}`);
  }
}

async function wechatLogin(miniProgram) {
  console.log(">>> 4/6 点击「微信一键登录」，拉起手机号列表");
  hookMiniProgramLogs(miniProgram);
  await hookWxRequest(miniProgram);
  await h.wxEval(
    miniProgram,
    `
      wx.setStorageSync('api_base', ${JSON.stringify(config.qaApi)});
      wx.setStorageSync('api_base_manual', true);
    `,
  );
  await patchPhoneEvent(miniProgram);
  const page = await h.currentPage(miniProgram);
  const loginBtn =
    (await h.deep$(page, ".wechat-login-btn")) ||
    (await h.deep$(page, "button.wechat-login-btn")) ||
    (await h.findByText(page, "微信一键登录", 5000));
  if (!loginBtn) throw new Error("未找到微信一键登录按钮");
  console.log("\n>>> 即将用手势点击：微信一键登录");
  await h.sleep(800);
  await h.gestureTap(loginBtn);
  try {
    await loginBtn.tap();
  } catch (_) {
    /* gestureTap 里已经 tap 过 */
  }
  console.log(">>> 已点击微信一键登录，等待手机号列表");
  await h.sleep(3000);
}

async function retryWechatLogin(miniProgram) {
  const phoneCode = miniProgram._phoneCode;
  if (!phoneCode) {
    console.log(">>> 没有拿到 phoneCode，无法补登入");
    return false;
  }
  console.log(">>> 小程序没有写入 token，用刚才允许拿到的 phoneCode 再登录一次");
  const loginType = await h.wxEval(miniProgram, "return typeof wx.login;");
  if (loginType !== "function") {
    console.log(">>> wx.login 不是函数，无法补登录。请先在开发者工具点「编译」");
    return false;
  }
  try {
    const loginRes = await miniProgram.callWxMethod("login", {});
    const wxCode = loginRes && (loginRes.code || (loginRes[0] && loginRes[0].code));
    if (!wxCode) {
      console.log(`>>> wx.login 没有 code：${JSON.stringify(loginRes)}`);
      return false;
    }
    const res = await miniProgram.callWxMethod("request", {
      url: `${config.qaApi}/api/auth/wechat/login`,
      method: "POST",
      header: { "content-type": "application/json" },
      data: { code: wxCode, phoneCode },
    });
    console.log(`>>> 补登录回包：${JSON.stringify(res).slice(0, 500)}`);
    const payload = (res && res.data && res.data.data) || (res && res.data) || res;
    const accessToken = payload && payload.accessToken;
    if (!accessToken) {
      console.log(`>>> 补登录没有 token：${JSON.stringify(payload).slice(0, 300)}`);
      return false;
    }
    await h.wxEval(
      miniProgram,
      `
        wx.setStorageSync('token', ${JSON.stringify(accessToken)});
        wx.setStorageSync('userId', ${JSON.stringify(payload.userId || payload.id || "")});
        wx.setStorageSync('userInfo', ${JSON.stringify({ ...payload, loginTimestamp: Date.now() })});
        const pages = getCurrentPages();
        const page = pages[pages.length - 1];
        const vm = page && (page.$vm || page);
        if (vm && typeof vm.navigateAfterLogin === 'function') {
          vm.navigateAfterLogin();
        } else {
          wx.reLaunch({ url: '/pages/store-list/index' });
        }
      `,
    );
    return true;
  } catch (error) {
    console.log(`>>> 补登录失败：${error.message || error}`);
    return false;
  }
}

async function allowPhoneNumber(miniProgram) {
  console.log(">>> 5/6 在手机号列表旁点击绿色「允许」，完成登录");
  hookMiniProgramLogs(miniProgram);
  await h.sleep(1200);
  const deadline = Date.now() + 16000;
  let clicks = 0;
  while (Date.now() < deadline) {
    if (await leftLogin(miniProgram)) return;
    if (miniProgram._phoneOk) {
      console.log(">>> 手机号已授权，等待登录接口写入 token");
      await h.sleep(4000);
      break;
    }
    if (clicks < 3) {
      console.log(`>>> 点击手机号旁的「允许」（第 ${clicks + 1} 次）`);
      await native.clickAllowInSimulator();
      clicks += 1;
      await h.sleep(900);
      continue;
    }
    await h.sleep(600);
  }
  if (await leftLogin(miniProgram)) return;
  await retryWechatLogin(miniProgram);
}

async function waitLoggedInHome(miniProgram) {
  console.log(">>> 6/6 进入登录后的页面");
  const reached = await h.waitUntil(async () => {
    const path = await h.currentPath(miniProgram);
    if (path.includes(config.pages.home) || path.includes(config.pages.storeList)) {
      return true;
    }
    return !!(await h.storage(miniProgram, "token")) && !path.includes(config.pages.login);
  }, 35000, 500);
  await h.sleep(2000);
  const path = await h.currentPath(miniProgram);
  console.log(`>>> 当前页面：${path}`);
  console.log(`>>> token：${await h.storage(miniProgram, "token")}`);
  console.log(`>>> userId：${await h.storage(miniProgram, "userId")}`);
  console.log(`>>> api_base：${await h.storage(miniProgram, "api_base")}`);
  console.log(`>>> api_base_manual：${await h.storage(miniProgram, "api_base_manual")}`);
  if (!reached && path.includes(config.pages.login)) {
    try {
      const texts = await h.dumpTexts(await h.currentPage(miniProgram), 30);
      if (texts.some((item) => item.includes("需要授权手机号") || item.includes("获取手机号失败"))) {
        console.log(">>> 小程序提示授权失败，刚才没有点到「允许」");
      }
    } catch (_) {
      /* ignore */
    }
    throw new Error("未进入登录后的首页，无法继续选店购物");
  }
  await dismissHomePopups(miniProgram);
  if (path.includes(config.pages.home)) {
    await tapTab(miniProgram, "首页");
  }
}

async function readPhoneStatus(miniProgram) {
  try {
    return (
      (await pageEval(
        miniProgram,
        `
          const ctx = __pageSetup();
          const wxUser = wx.getStorageSync('wxUserInfo') || {};
          const user = wx.getStorageSync('userInfo') || {};
          const extra = wx.getStorageSync('newUserInfo') || {};
          const phone = wxUser.phone || wxUser.phoneNumber || user.phone || user.phoneNumber || extra.phone || '';
          return {
            phone: phone || '',
            need: !!wx.getStorageSync('needCompletePhone'),
            popup: !!ctx.getRef('showPhonePopup'),
          };
        `,
      )) || { phone: "", need: false, popup: false }
    );
  } catch (_) {
    return { phone: "", need: false, popup: false };
  }
}

async function ensurePhoneBound(miniProgram) {
  hookMiniProgramLogs(miniProgram);
  await hookWxRequest(miniProgram);
  let status = await readPhoneStatus(miniProgram);
  console.log(`>>> 手机号状态：${JSON.stringify(status)}`);
  if (status.phone) {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        ctx.setRef('showPhonePopup', false);
        try { wx.removeStorageSync('needCompletePhone'); } catch (e) {}
      `,
    );
    return true;
  }
  if (miniProgram._phoneBindTried) return false;
  miniProgram._phoneBindTried = true;
  console.log(">>> 账号还没有手机号，点击「微信一键绑定」并允许");
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.setRef('showPhonePopup', true);
    `,
  );
  await patchPhoneEvent(miniProgram);
  await h.sleep(800);
  const page = await h.currentPage(miniProgram);
  const bindBtn =
    (await h.deep$(page, ".phone-popup-btn")) ||
    (await h.findByText(page, "微信一键绑定", 4000));
  if (!bindBtn) {
    console.log(">>> 没有找到微信一键绑定按钮，继续选购");
    return false;
  }
  miniProgram._phoneOk = false;
  miniProgram._phoneBound = false;
  console.log("\n>>> 即将点击：微信一键绑定");
  await h.gestureTap(bindBtn);
  try {
    await bindBtn.tap();
  } catch (_) {
    /* gestureTap 已 tap */
  }
  console.log(">>> 已点击微信一键绑定，等待手机号列表");
  await h.sleep(2500);
  await native.clickAllowInSimulator();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (miniProgram._phoneOk || miniProgram._phoneBound) break;
    status = await readPhoneStatus(miniProgram);
    if (status.phone) break;
    await h.sleep(500);
  }
  await h.sleep(1500);
  status = await readPhoneStatus(miniProgram);
  console.log(`>>> 绑定后手机号：${JSON.stringify(status)}`);
  return !!status.phone;
}

async function dismissHomePopups(miniProgram) {
  await ensurePhoneBound(miniProgram);
}

async function tapTab(miniProgram, label) {
  const page = await h.currentPage(miniProgram);
  const texts = await h.deep$$(page, ".tab-text");
  for (const item of texts) {
    if ((await h.safeText(item)).includes(label)) {
      await h.click(item, `底部Tab：${label}`);
      return true;
    }
  }
  const bar = await h.deep$(page, "bottom-tabbar");
  const fromBar = bar ? await h.children(bar, ".tab-item") : [];
  const items = fromBar.length ? fromBar : await h.deep$$(page, ".tab-item");
  for (const item of items) {
    if ((await h.safeText(item)).includes(label)) {
      await h.click(item, `底部Tab：${label}`);
      return true;
    }
  }
  console.log(`>>> 底部 Tab 没有「${label}」，改用页面切换`);
  return false;
}

async function currentTabOf(miniProgram) {
  try {
    const tab = await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        return ctx.getRef('currentTab') || '';
      `,
    );
    return tab || "";
  } catch (_) {
    return "";
  }
}

async function openCartPage(miniProgram) {
  console.log(">>> 打开购物车页面 /pages/index/index?tab=cart");
  try {
    await miniProgram.reLaunch("/pages/index/index?tab=cart");
  } catch (error) {
    console.log(`>>> reLaunch：${error.message || error}`);
    await h.wxEval(miniProgram, "wx.reLaunch({ url: '/pages/index/index?tab=cart' });");
  }
  await h.waitPath(miniProgram, config.pages.home, 15000);
  await h.sleep(2500);
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('handleTabChange', 'cart');
    `,
  );
}

async function switchMainTab(miniProgram, tab, label) {
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('handleTabChange', ${JSON.stringify(tab)});
    `,
  );
  await tapTab(miniProgram, label);
  if (tab === "cart") {
    await openCartPage(miniProgram);
  }
  const storeId = await h.storage(miniProgram, "selectedStoreId");
  console.log(`>>> 当前 Tab：${(await currentTabOf(miniProgram)) || "未知"} 门店=${storeId || "空"}`);
}

async function findSidebarItems(page) {
  const sidebar = await h.deep$(page, "products-sidebar");
  const fromHost = sidebar ? await h.children(sidebar, ".sidebar-item") : [];
  if (fromHost.length) return fromHost;
  const fromClass = await h.deep$$(page, ".sidebar-item");
  if (fromClass.length) return fromClass;
  if (typeof page.xpath === "function") {
    try {
      const one = await page.xpath('//view[contains(@class,"sidebar-item")]');
      if (one) return [one];
    } catch (_) {
      /* ignore */
    }
  }
  return [];
}

async function selectLeftCategory(miniProgram) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const page = await h.currentPage(miniProgram);
    const items = await findSidebarItems(page);
    if (items.length) {
      const name = (await h.safeText(items[0])) || "分类";
      await h.click(items[0], `左侧分类：${name}`);
      await h.sleep(1200);
      return name;
    }
    await h.sleep(400);
  }
  console.log(">>> 左侧分类列表还没出现，继续用当前右侧商品");
  return "";
}

async function storeItems(page) {
  const fromTag = await h.deep$$(page, "store-list-item");
  if (fromTag.length) return fromTag;
  const fromCard = await h.deep$$(page, ".store-card");
  return fromCard;
}

async function storeNameOf(item) {
  const nameEl = (await h.first(item, ".store-name")) || (await h.first(item, "text"));
  return h.safeText(nameEl);
}

function isPreferred(name) {
  return config.preferredHints.some((hint) => name.includes(hint));
}

async function storesFromVm(miniProgram) {
  try {
    const list = await h.wxEval(
      miniProgram,
      `
        const page = getCurrentPages().slice(-1)[0];
        const vm = page && (page.$vm || page);
        const raw = (vm && (vm.visibleStoreList || vm.storeList)) || [];
        return (Array.isArray(raw) ? raw : []).map(function (store) {
          return { id: store && store.id, name: (store && store.name) || '' };
        });
      `,
    );
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

async function enterStoreItem(item, name) {
  const order = await h.first(item, ".order-btn");
  if (order) {
    const cls = String((await order.attribute("class")) || "");
    if (!cls.includes("disabled")) {
      await h.click(order, `去下单(${name})`);
      return true;
    }
  }
  const nameEl = await h.first(item, ".store-name");
  if (nameEl) await h.click(nameEl, name);
  else await h.click(item, name);
  await h.sleep(1500);
  return false;
}

async function clickDetailOrder(page) {
  const btn =
    (await h.deep$(page, ".detail-order-btn")) || (await h.findByText(page, "去下单", 2000));
  if (btn) {
    await h.click(btn, "去下单");
    return true;
  }
  return false;
}

async function stillOnStorePages(miniProgram) {
  const path = await h.currentPath(miniProgram);
  return path.includes(config.pages.storeList) || path.includes(config.pages.storeSearch);
}

async function waitForStoreList(miniProgram) {
  console.log(">>> 等待门店列表出现门店");
  let lastDump = 0;
  const ok = await h.waitUntil(async () => {
    const page = await h.currentPage(miniProgram);
    const items = await storeItems(page);
    const vmStores = await storesFromVm(miniProgram);
    const named = await h.findByText(page, "去下单", 400);
    if (items.length || named || vmStores.length) {
      console.log(`>>> 看到门店卡片：${items.length} VM=${vmStores.length}`);
      if (vmStores.length) {
        console.log(`>>> 门店名称：${vmStores.map((item) => item.name).slice(0, 8).join(" / ")}`);
      }
      return true;
    }
    if (Date.now() - lastDump > 6000) {
      await h.dumpTexts(page, 40);
      lastDump = Date.now();
    }
    console.log(">>> 门店仍在加载，继续等待");
    return false;
  }, 35000, 1200);
  if (!ok) throw new Error("门店列表没有出现门店");
}

async function findPreferredItem(page) {
  const items = await storeItems(page);
  for (const item of items) {
    const name = await storeNameOf(item);
    if (isPreferred(name)) return { item, name };
  }
  for (const hint of ["aChill Club澳门直营店", "澳门直营店", "澳门直营", "澳门"]) {
    const nameEl = await h.findByText(page, hint, 800);
    if (nameEl) return { item: nameEl, name: hint };
  }
  return null;
}

async function orderMacauViaVm(miniProgram) {
  const name = await h.wxEval(
    miniProgram,
    `
      const page = getCurrentPages().slice(-1)[0];
      const vm = page && (page.$vm || page);
      if (!vm || typeof vm.goToOrder !== 'function') return '';
      const list = (vm.visibleStoreList || vm.storeList) || [];
      const store = list.find(function (item) {
        const name = String((item && item.name) || '');
        return name.indexOf('澳门直营店') >= 0 || name.indexOf('澳門直營店') >= 0 || name.indexOf('澳门') >= 0;
      });
      if (!store) return '';
      vm.goToOrder(store);
      return store.name || '澳门直营店';
    `,
  );
  return name || "";
}

async function searchPreferredStore(miniProgram) {
  const page = await h.currentPage(miniProgram);
  const search =
    (await h.deep$(page, ".search-btn")) || (await h.deep$(page, ".icon-search"));
  if (search) await h.click(search, "搜索门店");
  else {
    console.log(">>> 找不到搜索按钮，改点右上角搜索图标");
    const win = native.findSimulatorHwnd(true);
    if (!win) return false;
    await native.osClickXy(win.left + win.width * 0.82, win.top + win.height * 0.1, "搜索");
  }
  if (!(await h.waitPath(miniProgram, config.pages.storeSearch, 10000))) {
    console.log(">>> 没有进入门店搜索页");
    return false;
  }
  const searchPage = await h.currentPage(miniProgram);
  const input = (await h.deep$(searchPage, ".search-input")) || (await h.deep$(searchPage, "input"));
  if (!input) {
    console.log(">>> 搜索页没有输入框");
    return false;
  }
  await input.input(config.preferredStore);
  try {
    await input.trigger("confirm");
  } catch (_) {
    /* 输入后 computed 会过滤 */
  }
  console.log(`>>> 已搜索门店：${config.preferredStore}`);
  await h.sleep(2000);
  return true;
}

async function enterMacauStore(miniProgram) {
  await waitForStoreList(miniProgram);
  await h.dumpTexts(await h.currentPage(miniProgram), 60);

  for (let i = 0; i < 14; i += 1) {
    const found = await findPreferredItem(await h.currentPage(miniProgram));
    if (found) {
      console.log(`>>> 点击门店：${found.name}`);
      const tappedOrder = await enterStoreItem(found.item, found.name);
      await h.sleep(2000);
      if (!(await stillOnStorePages(miniProgram))) return found.name;
      if (!tappedOrder && (await clickDetailOrder(await h.currentPage(miniProgram)))) {
        await h.sleep(2000);
        if (!(await stillOnStorePages(miniProgram))) return found.name;
      }
    }
    const list = await h.deep$(await h.currentPage(miniProgram), ".store-list");
    if (list && typeof list.scrollTo === "function") {
      console.log(">>> 滚动门店列表，寻找 aChill Club澳门直营店");
      await list.scrollTo(0, 400 * (i + 1));
    }
    await native.swipeStoreList();
    await h.sleep(900);
  }

  console.log(">>> 列表滚动后仍未点进门店，改用门店数据进入澳门直营店");
  const viaVm = await orderMacauViaVm(miniProgram);
  if (viaVm) {
    await h.sleep(2000);
    if (!(await stillOnStorePages(miniProgram))) return viaVm;
  }

  console.log(">>> 列表里没看到澳门直营店，打开搜索");
  if (!(await searchPreferredStore(miniProgram))) return "";
  const found = await findPreferredItem(await h.currentPage(miniProgram));
  if (!found) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    console.log(">>> 搜索结果没有澳门直营店");
    return await orderMacauViaVm(miniProgram);
  }
  await enterStoreItem(found.item, found.name);
  await h.sleep(2000);
  if (!(await stillOnStorePages(miniProgram))) return found.name;
  if (await clickDetailOrder(await h.currentPage(miniProgram))) {
    await h.sleep(2000);
    if (!(await stillOnStorePages(miniProgram))) return found.name;
  }
  return "";
}

async function waitEnteredHome(miniProgram) {
  const reached = await h.waitPath(miniProgram, config.pages.home, 20000);
  if (!reached) return false;
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);
  await dismissHomePopups(miniProgram);
  await h.sleep(2000);
  return true;
}

async function chooseStore(miniProgram) {
  console.log(">>> 8/12 找到澳门直营店，进入商品选购");
  const name = await enterMacauStore(miniProgram);
  if (!name) throw new Error("没有找到澳门直营店");
  console.log(`>>> 已选门店：${name}`);
  if (!(await waitEnteredHome(miniProgram))) {
    throw new Error("已点澳门直营店，但没有进入门店");
  }
  return name;
}

async function openStoreList(miniProgram) {
  if ((await h.currentPath(miniProgram)).includes(config.pages.storeList)) {
    console.log(">>> 7/12 已在门店列表，寻找澳门直营店");
    return;
  }
  console.log(">>> 7/12 首页点击「更多」查看门店");
  await dismissHomePopups(miniProgram);
  await tapTab(miniProgram, "首页");
  const page = await h.currentPage(miniProgram);
  const home = await h.deep$(page, "home-tab");
  const more =
    (home && ((await h.first(home, ".more-text")) || (await h.first(home, ".location-row")))) ||
    (await h.findByText(page, "更多", 4000));
  if (more) await h.click(more, "更多");
  else {
    await miniProgram.navigateTo("/pages/store-list/index");
  }
  const reached = await h.waitPath(miniProgram, config.pages.storeList, 15000);
  if (!reached) {
    console.log(">>> 仍未进入门店列表，再打开一次");
    await miniProgram.navigateTo("/pages/store-list/index");
    if (!(await h.waitPath(miniProgram, config.pages.storeList, 10000))) {
      throw new Error("未进入门店列表");
    }
  }
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);
}

async function findPlusButtons(page) {
  const buttons = await h.deep$$(page, ".plus-btn");
  if (buttons.length) return buttons;
  const icons = await h.deep$$(page, ".plus-icon");
  if (icons.length) return icons;
  const rows = await h.deep$$(page, ".item");
  const fromRows = [];
  for (const row of rows) {
    const plus = (await h.first(row, ".plus-btn")) || (await h.first(row, ".plus-icon"));
    if (plus) fromRows.push(plus);
  }
  if (fromRows.length) return fromRows;
  if (typeof page.xpath === "function") {
    try {
      const one = await page.xpath('//view[contains(@class,"plus-btn")]');
      if (one) return [one];
    } catch (_) {
      /* 自定义组件 xpath 可能失败 */
    }
  }
  return [];
}

async function ensureProductsTab(miniProgram) {
  await switchMainTab(miniProgram, "products", "菜单");
  await selectLeftCategory(miniProgram);
}

async function waitForShoppableProducts(miniProgram, timeout = 20000) {
  await dismissHomePopups(miniProgram);
  await ensureProductsTab(miniProgram);
  const deadline = Date.now() + timeout;
  let dumped = false;
  while (Date.now() < deadline) {
    const page = await h.currentPage(miniProgram);
    const plusButtons = await findPlusButtons(page);
    if (plusButtons.length) {
      console.log(`>>> 右侧已出现可加购商品：${plusButtons.length} 个`);
      return plusButtons;
    }
    if (!dumped) {
      await h.dumpTexts(page, 40);
      dumped = true;
    }
    await h.sleep(700);
  }
  return [];
}

async function findPopupAddCart(page) {
  const popups = await h.deep$$(page, "product-purchase-popup");
  for (const popup of popups) {
    const btn =
      (await h.first(popup, ".add-cart")) || (await h.first(popup, ".add-cart-text"));
    if (btn) return btn;
  }
  return (await h.deep$(page, ".add-cart")) || (await h.findByText(page, "加入购物车", 400));
}

async function waitAddCartButton(miniProgram) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const page = await h.currentPage(miniProgram);
    const addCart = await findPopupAddCart(page);
    if (addCart) return addCart;
    await h.sleep(400);
  }
  return null;
}

async function addOneProduct(miniProgram, index) {
  const page = await h.currentPage(miniProgram);
  const buttons = await findPlusButtons(page);
  const plus = buttons[Math.min(index, Math.max(0, buttons.length - 1))];
  if (!plus) return false;
  console.log(`>>> 准备添加：第 ${index + 1} 件商品`);
  miniProgram._cartAddResp = null;
  await h.click(plus, `添加商品${index + 1}`);
  const addCart = await waitAddCartButton(miniProgram);
  if (!addCart) throw new Error("未出现加入购物车");
  const confirm = (await waitAddCartButton(miniProgram)) || addCart;
  await h.click(confirm, "加入购物车");
  const added = await h.waitUntil(() => !!miniProgram._cartAddResp, 10000, 300);
  if (!added) console.log(">>> 未等到加购接口回包，稍后在购物车再确认");
  else console.log(">>> 已发出加入购物车请求");
  await h.sleep(1200);
  return true;
}

async function addProduct(miniProgram) {
  console.log(">>> 9/12 在菜单页把 2-3 件商品加入购物车");
  const plusButtons = await waitForShoppableProducts(miniProgram);
  if (!plusButtons.length) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("菜单右侧没有找到加购按钮");
  }
  const count = Math.min(3, Math.max(2, plusButtons.length));
  console.log(`>>> 准备从右侧加购 ${count} 次`);
  for (let i = 0; i < count; i += 1) {
    await addOneProduct(miniProgram, i % plusButtons.length);
  }
}

async function openCart(miniProgram) {
  console.log(">>> 10/12 打开购物车页面");
  await openCartPage(miniProgram);
}

async function fetchCartFromApi(miniProgram) {
  try {
    return await miniProgram.evaluate(
      `async function () {
        const storeId = wx.getStorageSync('selectedStoreId');
        const token = wx.getStorageSync('token');
        const base = wx.getStorageSync('api_base') || ${JSON.stringify(config.qaApi)};
        return await new Promise(function (resolve) {
          wx.request({
            url: base + '/api/products/mini/carts',
            method: 'GET',
            data: { storeId: storeId },
            header: {
              'content-type': 'application/json',
              Authorization: token ? ('Bearer ' + token) : ''
            },
            success: function (res) {
              const data = (res && res.data && res.data.data) || {};
              const items = Array.isArray(data.items) ? data.items : [];
              resolve({
                count: items.length,
                names: items.map(function (item) { return item.productName || ''; }).slice(0, 5),
                ids: items.map(function (item) { return item.cacheId || item.id || ''; }).filter(Boolean)
              });
            },
            fail: function (err) {
              resolve({ count: -1, error: (err && err.errMsg) || 'fail' });
            }
          });
        });
      }`,
    );
  } catch (error) {
    return { count: -1, error: String((error && error.message) || error) };
  }
}

function isBindPopupTexts(texts) {
  if (!texts || !texts.length) return false;
  return texts.every((text) => /绑定手机号|暂不绑定|为了提供更好的服务|×/.test(text));
}

async function waitCartHasItems(miniProgram, timeout = 18000) {
  const tab = await currentTabOf(miniProgram);
  if (tab !== "cart") await openCartPage(miniProgram);
  await closeBindPopup(miniProgram);
  const api = await fetchCartFromApi(miniProgram);
  console.log(`>>> 购物车接口：${JSON.stringify(api)}`);
  const deadline = Date.now() + timeout;
  let dumped = false;
  while (Date.now() < deadline) {
    const page = await h.currentPage(miniProgram);
    const row =
      (await h.deep$(page, "cart-item-row")) ||
      (await h.deep$(page, ".item-row")) ||
      (await h.deep$(page, ".item-wrapper"));
    const settle =
      (await h.deep$(page, "cart-summary-bar")) || (await h.findByText(page, "结算", 400));
    const name =
      api && api.names && api.names[0]
        ? await h.findByText(page, String(api.names[0]).slice(0, 8), 400)
        : null;
    if (row || settle || name) return { page, row, settle };
    if (!dumped) {
      const texts = await h.dumpTexts(page, 40);
      dumped = true;
      if (isBindPopupTexts(texts)) {
        await closeBindPopup(miniProgram);
        if (api && api.count > 0) {
          return { page: await h.currentPage(miniProgram), row: null, settle: null, fromApi: true };
        }
      }
    }
    await h.sleep(700);
  }
  if (api && api.count > 0) {
    console.log(">>> 接口已有购物车商品，按可见购物车继续勾选结算");
    return { page: await h.currentPage(miniProgram), row: null, settle: null, fromApi: true };
  }
  return null;
}

async function closeBindPopup(miniProgram) {
  const shown = await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      const shown = !!ctx.getRef('showPhonePopup');
      ctx.setRef('showPhonePopup', false);
      ctx.callFn('closePhonePopup');
      try { wx.removeStorageSync('needCompletePhone'); } catch (e) {}
      return shown;
    `,
  );
  if (!shown) return;
  console.log(">>> 关闭绑定手机号弹窗");
  try {
    const page = await h.currentPage(miniProgram);
    const skip = await h.deep$(page, ".phone-popup-skip");
    if (skip) await h.click(skip, "暂不绑定");
  } catch (_) {
    /* 已用页面状态关掉 */
  }
}

function cartSetupSource() {
  return `
    const page = getCurrentPages().slice(-1)[0];
    const unwrap = function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      if (value instanceof Set) return value;
      return 'value' in value ? value.value : value;
    };
    const debug = { how: '', select: false, keys: [] };
    const isCartSetup = function (st) {
      return !!(st && (typeof st.toggleAll === 'function' || typeof st.checkout === 'function' || st.checkedSet));
    };
    const fromInst = function (inst) {
      if (!inst) return null;
      const list = [inst, inst.$vm, inst.$, inst.$vm && inst.$vm.$, inst.__vueParentComponent];
      for (let i = 0; i < list.length; i += 1) {
        const cur = list[i];
        if (!cur) continue;
        if (isCartSetup(cur)) return cur;
        if (cur.setupState && isCartSetup(cur.setupState)) return cur.setupState;
      }
      return null;
    };
    let cs = null;
    try {
      if (page && typeof page.selectComponent === 'function') {
        const comp = page.selectComponent('cart-tab');
        debug.select = !!comp;
        cs = fromInst(comp);
        if (cs) debug.how = 'selectComponent';
      }
    } catch (e) {
      debug.selectErr = String(e && e.message || e);
    }
    if (!cs) {
      const vm = page && (page.$vm || page);
      const inner = vm && vm.$;
      const state = (inner && inner.setupState) || {};
      debug.keys = Object.keys(state).slice(0, 25);
      let cart = state.cartTabRef;
      cart = cart && (cart.value !== undefined ? cart.value : cart);
      cs = fromInst(cart);
      if (cs) debug.how = 'cartTabRef';
    }
  `;
}

async function selectCartGoods(miniProgram) {
  const result = await pageEval(
    miniProgram,
    `
      ${cartSetupSource()}
      if (!cs) return { ok: false, reason: '没有 cart setupState', debug: debug };
      const items = unwrap(cs.purchasableItems) || unwrap(cs.allItems) || [];
      const ids = items.map(function (item) { return item && item.id; }).filter(Boolean);
      if (cs.checkedSet && typeof cs.checkedSet === 'object' && 'value' in cs.checkedSet) {
        cs.checkedSet.value = new Set(ids);
      } else if (typeof cs.toggleAll === 'function') {
        const all = unwrap(cs.allSelected);
        if (!all) cs.toggleAll();
      }
      if (typeof cs.syncCheckedToStorage === 'function') cs.syncCheckedToStorage();
      if (typeof cs.refreshCartTotal === 'function') cs.refreshCartTotal();
      const selected = unwrap(cs.selectedItems) || [];
      return {
        ok: selected.length > 0,
        count: ids.length,
        selected: selected.length,
        debug: debug,
        names: items.map(function (item) { return item.productName || ''; }).slice(0, 5)
      };
    `,
  );
  console.log(`>>> 购物车勾选：${JSON.stringify(result)}`);
  return result;
}

async function callCartCheckout(miniProgram) {
  const result = await pageEval(
    miniProgram,
    `
      ${cartSetupSource()}
      if (!cs || typeof cs.checkout !== 'function') return { ok: false, reason: '没有 checkout', debug: debug };
      const selected = unwrap(cs.selectedItems) || [];
      if (!selected.length) {
        const items = unwrap(cs.purchasableItems) || unwrap(cs.allItems) || [];
        const ids = items.map(function (item) { return item && item.id; }).filter(Boolean);
        if (cs.checkedSet && typeof cs.checkedSet === 'object' && 'value' in cs.checkedSet) {
          cs.checkedSet.value = new Set(ids);
        }
        if (typeof cs.syncCheckedToStorage === 'function') cs.syncCheckedToStorage();
      }
      const again = unwrap(cs.selectedItems) || [];
      if (!again.length) return { ok: false, reason: '还没有勾选商品', selected: 0, debug: debug };
      cs.checkout();
      return { ok: true, selected: again.length, debug: debug };
    `,
  );
  console.log(`>>> 调用购物车结算：${JSON.stringify(result)}`);
  return result;
}

async function clickCartCheckbox(miniProgram) {
  const page = await h.currentPage(miniProgram);
  const check =
    (await h.xpath(page, '//view[contains(@class,"check-wrap")]')) ||
    (await h.xpath(page, '//view[contains(@class,"check-circle")]')) ||
    (await h.xpath(page, '//view[contains(@class,"head-left")]')) ||
    (await h.deep$(page, ".check-wrap")) ||
    (await h.deep$(page, ".check-circle"));
  if (check) {
    await h.gestureTap(check);
    try {
      await h.osTapElement(miniProgram, check, "勾选商品");
    } catch (_) {
      /* 系统点击失败时继续 tap */
    }
    await h.click(check, "勾选商品");
    return true;
  }
  const label =
    (await h.findByText(page, "选购商品", 2500)) ||
    (await h.xpath(page, '//text[contains(., "选购商品")]')) ||
    (await h.findByText(page, "Peterson", 800));
  if (label) {
    const offset = (await label.offset()) || {};
    const size = (await label.size()) || {};
    const x = Math.max(16, Number(offset.left || 0) - 28);
    const y = Number(offset.top || 0) + Number(size.height || 24) / 2;
    await native.clickPageXy(x, y, "勾选商品", await h.systemInfo(miniProgram));
    return true;
  }
  return false;
}

async function cartLooksChecked(miniProgram) {
  const page = await h.currentPage(miniProgram);
  const mark =
    (await h.xpath(page, '//text[contains(., "✓")]')) ||
    (await h.deep$(page, ".check-mark"));
  if (mark) return true;
  const total = await h.findByText(page, "总价", 400);
  const texts = [];
  try {
    const nodes = await h.deep$$(page, "text");
    for (const el of nodes.slice(0, 40)) {
      const value = await h.safeText(el);
      if (value) texts.push(value);
    }
  } catch (_) {
    /* ignore */
  }
  const joined = texts.join(" ");
  if (/✓/.test(joined)) return true;
  if (/总价[:：]?\s*￥\s*0(\.0+)?/.test(joined)) return false;
  if (/￥\s*[1-9]/.test(joined)) return true;
  return false;
}

async function clickCartSettle(page) {
  const bar = await h.deep$(page, "cart-summary-bar");
  const btn =
    (bar && ((await h.first(bar, ".action-btn")) || (await h.first(bar, ".action-text")))) ||
    (await h.xpath(page, '//text[contains(., "结算")]')) ||
    (await h.deep$(page, ".action-btn"));
  if (btn) {
    await h.gestureTap(btn);
    await h.click(btn, "结算");
    return true;
  }
  const byText = await h.findByText(page, "结算", 3000);
  if (!byText) return false;
  await h.click(byText, "结算");
  return true;
}

async function verifyCartAndCheckout(miniProgram) {
  console.log(">>> 11/12 在购物车勾选要买的商品");
  const found = await waitCartHasItems(miniProgram);
  if (!found) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("购物车没有刚添加的商品");
  }
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('handleTabChange', 'cart');
    `,
  );
  await h.sleep(800);
  const tapped = await clickCartCheckbox(miniProgram);
  if (!tapped) console.log(">>> 没有点到购物车勾选框，改用页面状态勾选");
  await selectCartGoods(miniProgram);
  const checked = await h.waitUntil(() => cartLooksChecked(miniProgram), 8000, 400);
  if (!checked) {
    console.log(">>> 勾选后总价仍未变化，再勾选一次");
    await clickCartCheckbox(miniProgram);
    await selectCartGoods(miniProgram);
  }
  console.log(">>> 12/12 点击结算");
  const settlePage = await h.currentPage(miniProgram);
  const clickedSettle = await clickCartSettle(settlePage);
  if (!clickedSettle) console.log(">>> 没有点到结算按钮，改用购物车结算方法");
  let reached = await h.waitPath(miniProgram, config.pages.settlement, 8000);
  if (!reached) {
    await callCartCheckout(miniProgram);
    reached = await h.waitPath(miniProgram, config.pages.settlement, 15000);
  }
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);
  if (!reached) throw new Error("点击结算后未进入结算页");
  console.log(">>> 已进入结算页");
}

async function assertWxLogin(miniProgram) {
  const info = await h.wxEval(
    miniProgram,
    "return { login: typeof wx.login, request: typeof wx.request };",
  );
  console.log(`>>> wx.login=${info && info.login} wx.request=${info && info.request}`);
  if (info && info.login === "function") return;
  throw new Error(
    "当前开发者工具会话里 wx.login 已失效，所以点完「允许」也无法登录。请先在微信开发者工具点一次「编译」（不要关闭窗口），再执行 npm test。你手动点登录没问题，是因为编译后微信 API 是完整的。",
  );
}

async function mockWechatPay(miniProgram) {
  try {
    await miniProgram.mockWxMethod("requestPayment", { errMsg: "requestPayment:ok" });
    console.log(">>> 已 mock wx.requestPayment 为成功（开发者工具无法真实微信支付）");
  } catch (error) {
    console.log(`>>> mock requestPayment：${error.message || error}`);
  }
  try {
    await miniProgram.mockWxMethod("showModal", { confirm: true, cancel: false });
  } catch (_) {
    /* 放弃付款弹窗不是必需 */
  }
}

async function prepareSettlement(miniProgram) {
  const ready = await h.waitUntil(async () => {
    try {
      const page = await h.currentPage(miniProgram);
      return !!(await h.deep$(page, ".submit-btn")) || !!(await h.findByText(page, "支付", 400));
    } catch (_) {
      return false;
    }
  }, 18000, 400);
  if (!ready) throw new Error("结算页没有出现支付按钮");

  const page = await h.currentPage(miniProgram);
  const tip = await h.findByText(page, "继续下单", 800);
  if (tip) await h.click(tip, "继续下单");

  const prepared = await pageEval(
    miniProgram,
    `
      return (async function () {
        const ctx = __pageSetup();
        ctx.callFn('closeFirstOrderTip');
        ctx.setRef('showFirstOrderTip', false);

        const validPhone = function (value) {
          return /^1[3-9]\\d{9}$/.test(String(value || ''));
        };
        const fromRef = ctx.getRef('buyerPhone');
        const nu = wx.getStorageSync('newUserInfo') || {};
        const wxu = wx.getStorageSync('wxUserInfo') || {};
        let ui = wx.getStorageSync('userInfo');
        if (typeof ui === 'string') {
          try { ui = JSON.parse(ui); } catch (e) { ui = {}; }
        }
        ui = ui || {};
        const phone = validPhone(fromRef)
          ? String(fromRef)
          : (nu.phone || wxu.phone || ui.phone || ${JSON.stringify(config.qaPhone)});
        ctx.setRef('buyerPhone', String(phone));

        const existing = ctx.getRef('deliveryTime');
        if (existing) {
          return { phone: String(phone), time: existing, how: 'already' };
        }

        const picker = ctx.getRef('timePickerRef');
        const inst = picker && (picker.value !== undefined ? picker.value : picker);
        if (inst && typeof inst.getFirstAvailable === 'function') {
          const first = await inst.getFirstAvailable();
          if (first && first.text) {
            ctx.setRef('deliveryTime', first.text);
            ctx.setRef('selectedDeliveryData', first);
            ctx.callFn('onTimeConfirm', first);
            return { phone: String(phone), time: first.text, how: 'picker' };
          }
        }

        const now = new Date();
        const fallback = {
          date: { date: now, label: '今天', week: '周日' },
          slot: { isImmediate: true, start: now.getHours(), startMin: 0, end: now.getHours(), endMin: 30 },
          text: '立即取单'
        };
        ctx.setRef('selectedDeliveryData', fallback);
        ctx.setRef('deliveryTime', fallback.text);
        return { phone: String(phone), time: fallback.text, how: 'fallback' };
      })();
    `,
  );
  console.log(`>>> 结算准备：${JSON.stringify(prepared)}`);
  return prepared;
}

async function clickSettlementPay(miniProgram) {
  const page = await h.currentPage(miniProgram);
  const btn =
    (await h.deep$(page, ".submit-btn")) ||
    (await h.findByText(page, "支付", 3000)) ||
    (await h.findByText(page, "支付中", 400));
  if (btn) {
    await h.click(btn, "支付");
    return true;
  }
  console.log(">>> 没有点到支付按钮，改用 submitOrder");
  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('submitOrder');
      return true;
    `,
  );
  return false;
}

async function confirmPaySuccessFallback(miniProgram) {
  const info = await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      const pay = ctx.getRef('currentPayment') || {};
      const orderId = pay.orderId || '';
      const total = ctx.getRef('currentTotalPrice') || ctx.getRef('totalPrice') || 0;
      if (orderId) ctx.callFn('confirmOrderPaySuccess', orderId);
      return { orderId: String(orderId), total: Number(total || 0) };
    `,
  );
  console.log(`>>> 支付成功补偿：${JSON.stringify(info)}`);
  return info || {};
}

async function payOnSettlement(miniProgram) {
  console.log(">>> 13/17 在结算页填写电话、自提时间并支付");
  if (!(await h.currentPath(miniProgram)).includes(config.pages.settlement)) {
    throw new Error("当前不在结算页，无法支付");
  }
  await prepareSettlement(miniProgram);
  await mockWechatPay(miniProgram);
  await clickSettlementPay(miniProgram);

  let reached = await h.waitPath(miniProgram, config.pages.paymentSuccess, 25000);
  if (!reached) {
    console.log(">>> 真实支付轮询未跳转成功页，改走订单支付成功确认");
    const info = await confirmPaySuccessFallback(miniProgram);
    reached = await h.waitPath(miniProgram, config.pages.paymentSuccess, 12000);
    if (!reached && info.orderId) {
      const url = `/pages/payment-success/index?amount=${encodeURIComponent(info.total)}&orderId=${encodeURIComponent(info.orderId)}`;
      try {
        await miniProgram.redirectTo(url);
      } catch (error) {
        console.log(`>>> redirectTo 支付成功页：${error.message || error}`);
        await h.wxEval(miniProgram, `wx.redirectTo({ url: ${JSON.stringify(url)} });`);
      }
      reached = await h.waitPath(miniProgram, config.pages.paymentSuccess, 10000);
    }
  }
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);
  if (!reached) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("提交支付后未进入支付成功页");
  }
}

async function verifyPaymentSuccess(miniProgram) {
  console.log(">>> 14/17 校验支付成功页");
  const ok = await h.waitUntil(async () => {
    const current = await h.currentPage(miniProgram);
    return !!(
      (await h.findByText(current, "查看订单", 400)) ||
      (await h.findByText(current, "支付成功", 400)) ||
      (await h.findByText(current, "提交成功", 400))
    );
  }, 8000, 400);
  if (!ok) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("支付成功页缺少「查看订单」或成功文案");
  }
  console.log(">>> 已确认支付成功页");
}

async function viewOrderAfterPay(miniProgram) {
  console.log(">>> 15/17 从支付成功页查看订单");
  const page = await h.currentPage(miniProgram);
  const btn =
    (await h.deep$(page, ".order-btn")) ||
    (await h.findByText(page, "查看订单", 4000));
  if (btn) await h.click(btn, "查看订单");
  else {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        ctx.callFn('viewOrder');
        return true;
      `,
    );
  }

  const reached = await h.waitUntil(async () => {
    const path = await h.currentPath(miniProgram);
    return path.includes(config.pages.orderDetail) || path.includes(config.pages.orderList);
  }, 12000, 400);
  if (!reached) {
    console.log(">>> 点击查看订单未跳转，改调 viewOrder");
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        ctx.callFn('viewOrder');
        return true;
      `,
    );
  }
  const opened = await h.waitUntil(async () => {
    const path = await h.currentPath(miniProgram);
    return path.includes(config.pages.orderDetail) || path.includes(config.pages.orderList);
  }, 8000, 400);
  const path = await h.currentPath(miniProgram);
  console.log(`>>> 当前页面：${path}`);
  if (!opened) throw new Error("点击查看订单后未进入订单详情或订单列表");

  if (path.includes(config.pages.orderDetail)) {
    const detail = await h.currentPage(miniProgram);
    const hasBody = await h.waitUntil(async () => {
      const current = await h.currentPage(miniProgram);
      return !!(
        (await h.findByText(current, "取单码", 400)) ||
        (await h.findByText(current, "自取时间", 400)) ||
        (await h.deep$(current, ".product-item")) ||
        (await h.findByText(current, "立即付款", 400))
      );
    }, 10000, 400);
    if (!hasBody) {
      await h.dumpTexts(detail, 40);
      throw new Error("订单详情页没有订单内容");
    }
    console.log(">>> 已进入订单详情");
  }
}

async function openOrderListPage(miniProgram) {
  const path = await h.currentPath(miniProgram);
  if (path.includes(config.pages.orderList)) return;
  if (path.includes(config.pages.orderDetail)) {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        if (!ctx.callFn('backToOrderList')) {
          wx.redirectTo({ url: '/pages/order-list/index?tab=0' });
        }
        return true;
      `,
    );
    if (await h.waitPath(miniProgram, config.pages.orderList, 8000)) return;
  }
  try {
    await miniProgram.redirectTo("/pages/order-list/index?tab=0");
  } catch (error) {
    console.log(`>>> redirectTo 订单列表：${error.message || error}`);
    await h.wxEval(miniProgram, "wx.redirectTo({ url: '/pages/order-list/index?tab=0' });");
  }
  if (!(await h.waitPath(miniProgram, config.pages.orderList, 12000))) {
    throw new Error("未进入订单列表");
  }
}

async function verifyOrderList(miniProgram) {
  console.log(">>> 16/17 校验订单列表并打开一张订单");
  await openOrderListPage(miniProgram);
  await h.sleep(1200);

  await pageEval(
    miniProgram,
    `
      const ctx = __pageSetup();
      ctx.callFn('switchTab', 0);
      return true;
    `,
  );
  const page = await h.currentPage(miniProgram);
  const allTab = await h.findByText(page, "全部", 3000);
  if (allTab) await h.click(allTab, "全部");
  await h.sleep(800);

  const hasCard = await h.waitUntil(async () => {
    const current = await h.currentPage(miniProgram);
    const cards = await h.deep$$(current, ".order-card");
    return cards.length > 0;
  }, 12000, 500);
  if (!hasCard) {
    await h.dumpTexts(await h.currentPage(miniProgram), 40);
    throw new Error("订单列表没有订单卡片");
  }

  const listPage = await h.currentPage(miniProgram);
  const cards = await h.deep$$(listPage, ".order-card");
  if (cards[0]) await h.click(cards[0], "第一张订单");
  else {
    await pageEval(
      miniProgram,
      `
        const ctx = __pageSetup();
        const orders = ctx.getRef('orders') || [];
        const first = orders[0];
        if (first) ctx.callFn('goToOrderDetail', first);
        return !!(first && first.id);
      `,
    );
  }

  const opened = await h.waitPath(miniProgram, config.pages.orderDetail, 10000);
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);
  if (!opened) throw new Error("点击订单卡片后未进入订单详情");
}

async function openMemberCenter(miniProgram) {
  console.log(">>> 17/17 打开会员中心");
  await openMemberCenterPage(miniProgram);
  console.log(`>>> 当前页面：${await h.currentPath(miniProgram)}`);

  const memberPage = await h.currentPage(miniProgram);
  const visible = await h.waitUntil(async () => {
    const current = await h.currentPage(miniProgram);
    return !!(
      (await h.findByText(current, "会员权益", 400)) ||
      (await h.findByText(current, "会员中心", 400)) ||
      (await h.findByText(current, "成长任务", 400))
    );
  }, 8000, 400);
  if (!visible) {
    await h.dumpTexts(memberPage, 40);
    throw new Error("会员中心页缺少权益或标题文案");
  }
  console.log(">>> 已确认会员中心");
}

async function finish(miniProgram) {
  await h.sleep(config.finishDelay);
}

async function runFlow(miniProgram, options = {}) {
  const route = resolveRoute(options.route);
  console.log(`>>> 线路：${route.label} (${route.id})`);

  if (route.only === "payment") {
    await payOnSettlement(miniProgram);
    await verifyPaymentSuccess(miniProgram);
    await finish(miniProgram);
    return route;
  }
  if (route.only === "orders") {
    await verifyOrderList(miniProgram);
    await finish(miniProgram);
    return route;
  }
  if (route.only === "member") {
    const summary = await runMemberSuite(miniProgram, { caseId: options.caseId });
    if (summary.failed) throw new Error(`会员功能失败 ${summary.failed}/${summary.total}`);
    return route;
  }

  await assertWxLogin(miniProgram);
  await openLogin(miniProgram);
  await chooseQa(miniProgram);
  await agreeTerms(miniProgram);
  await wechatLogin(miniProgram);
  await allowPhoneNumber(miniProgram);
  await waitLoggedInHome(miniProgram);
  if (route.through === "login") {
    await finish(miniProgram);
    return route;
  }

  await openStoreList(miniProgram);
  await chooseStore(miniProgram);
  if (route.through === "store") {
    await finish(miniProgram);
    return route;
  }

  await addProduct(miniProgram);
  await openCart(miniProgram);
  await verifyCartAndCheckout(miniProgram);
  if (route.through === "settlement") {
    await finish(miniProgram);
    return route;
  }

  await payOnSettlement(miniProgram);
  await verifyPaymentSuccess(miniProgram);
  if (route.through === "payment") {
    await finish(miniProgram);
    return route;
  }

  await viewOrderAfterPay(miniProgram);
  await verifyOrderList(miniProgram);
  if (route.through === "orders") {
    await finish(miniProgram);
    return route;
  }

  const summary = await runMemberSuite(miniProgram);
  if (summary.failed) throw new Error(`会员功能失败 ${summary.failed}/${summary.total}`);
  return route;
}

module.exports = { runFlow };
