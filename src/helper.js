const native = require("./native-win");

const COMP_TAGS = [
  "home-tab",
  "products-tab",
  "cart-tab",
  "bottom-tabbar",
  "store-list-item",
  "product-list",
  "products-list-item",
  "product-purchase-popup",
  "cart-summary-bar",
  "cart-item-row",
  "cart-shop-group",
  "search-nav-bar",
  "products-sidebar",
  "profile-tab",
  "profile-member-card",
  "profile-section-card",
];

function sleep(ms) {
  return native.sleep(ms);
}

async function waitUntil(fn, timeout = 20000, interval = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch (_) {
      /* continue */
    }
    await sleep(interval);
  }
  return false;
}

async function currentPage(miniProgram) {
  let lastError = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      const page = await miniProgram.currentPage();
      if (page) return page;
    } catch (error) {
      lastError = error;
      const msg = String((error && error.message) || error);
      if (!/not on top|rawPath|getPageMetaByWebviewId/i.test(msg) && i >= 5) break;
    }
    await sleep(400);
  }
  throw lastError || new Error("没有当前页面");
}

async function currentPath(miniProgram) {
  const page = await currentPage(miniProgram);
  return String((page && page.path) || "").replace(/^\//, "");
}

async function wxEval(miniProgram, source) {
  return miniProgram.evaluate(`function () { ${source} }`);
}

async function storage(miniProgram, key) {
  return wxEval(miniProgram, `return wx.getStorageSync(${JSON.stringify(key)});`);
}

async function systemInfo(miniProgram) {
  try {
    return (await wxEval(miniProgram, "return wx.getSystemInfoSync();")) || {};
  } catch (_) {
    return {};
  }
}

async function safeText(el) {
  if (!el) return "";
  try {
    return String((await el.text()) || "").trim();
  } catch (_) {
    return "";
  }
}

async function click(el, label) {
  if (!el) throw new Error(`未找到：${label}`);
  console.log(`\n>>> 即将点击：${label}`);
  await sleep(1000);
  try {
    await el.tap();
  } catch (error) {
    const msg = String((error && error.message) || error);
    if (/not on top|rawPath|getPageMetaByWebviewId/i.test(msg)) {
      console.log(`>>> 点击「${label}」时页面不是栈顶，跳过这次 tap`);
      return false;
    }
    throw error;
  }
  console.log(`>>> 已点击：${label}`);
  await sleep(2000);
  return true;
}

async function gestureTap(el) {
  const size = (await el.size()) || {};
  const offset = (await el.offset()) || {};
  const width = Number(size.width || 0);
  const height = Number(size.height || 0);
  const left = Number(offset.left || 0);
  const top = Number(offset.top || 0);
  const touch = {
    identifier: 0,
    pageX: left + Math.floor(width / 2),
    pageY: top + Math.floor(height / 2),
    clientX: left + Math.floor(width / 2),
    clientY: top + Math.floor(height / 2),
  };
  try {
    await el.touchstart({ touches: [touch], changeTouches: [touch] });
    await sleep(80);
    await el.touchend({ changeTouches: [touch] });
  } catch (error) {
    console.log(`>>> 触摸手势未生效：${error.message || error}`);
  }
  await sleep(150);
  try {
    await el.tap();
  } catch (error) {
    console.log(`>>> 手势 tap 未生效：${error.message || error}`);
  }
}

async function osTapElement(miniProgram, el, label) {
  const info = await systemInfo(miniProgram);
  const size = (await el.size()) || {};
  const offset = (await el.offset()) || {};
  const x = Number(offset.left || 0) + Number(size.width || 0) / 2;
  const y = Number(offset.top || 0) + Number(size.height || 0) / 2;
  return native.clickPageXy(x, y, label, info);
}

async function children(root, selector) {
  if (!root) return [];
  try {
    if (typeof root.$$ === "function") {
      return (await root.$$(selector)) || [];
    }
    if (typeof root.$ === "function") {
      const one = await root.$(selector);
      return one ? [one] : [];
    }
  } catch (_) {
    return [];
  }
  return [];
}

async function first(root, selector) {
  const items = await children(root, selector);
  return items[0] || null;
}

async function walkHosts(root, visit, depth = 0) {
  if (!root || depth > 4) return;
  for (const tag of COMP_TAGS) {
    const hosts = await children(root, tag);
    for (const host of hosts) {
      const stop = await visit(host, tag);
      if (stop) return true;
      if (await walkHosts(host, visit, depth + 1)) return true;
    }
  }
  return false;
}

async function deep$(page, selector) {
  const top = await first(page, selector);
  if (top) return top;
  let found = null;
  await walkHosts(page, async (host) => {
    const el = await first(host, selector);
    if (el) {
      found = el;
      return true;
    }
    return false;
  });
  return found;
}

async function deep$$(page, selector) {
  const acc = await children(page, selector);
  await walkHosts(page, async (host) => {
    const items = await children(host, selector);
    acc.push(...items);
    return false;
  });
  return acc;
}

async function findByText(page, text, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    if (typeof page.xpath === "function") {
      try {
        const byXpath =
          (await page.xpath(`//text[contains(., "${text}")]`)) ||
          (await page.xpath(`//view[contains(., "${text}")]`));
        if (byXpath) return byXpath;
      } catch (_) {
        /* 自定义组件内 xpath 可能失败，改为遍历 */
      }
    }
    const texts = await deep$$(page, "text");
    for (const el of texts) {
      const value = await safeText(el);
      if (value.includes(text)) return el;
    }
    if (Date.now() >= deadline) break;
    await sleep(400);
  }
  return null;
}

async function xpath(page, expr) {
  if (!page || typeof page.xpath !== "function") return null;
  try {
    return (await page.xpath(expr)) || null;
  } catch (_) {
    return null;
  }
}

async function dumpTexts(page, limit = 60) {
  const texts = [];
  const nodes = await deep$$(page, "text");
  for (const el of nodes) {
    const value = await safeText(el);
    if (value) texts.push(value);
    if (texts.length >= limit) break;
  }
  console.log(`>>> 页面文字：${JSON.stringify(texts.slice(0, 20))}`);
  return texts;
}

async function waitPath(miniProgram, part, timeout = 20000) {
  return waitUntil(async () => (await currentPath(miniProgram)).includes(part), timeout);
}

async function restoreLeftoverMocks(miniProgram) {
  try {
    await miniProgram.mockWxMethod("getLocation", {
      latitude: 22.3193,
      longitude: 114.1694,
      accuracy: 65,
    });
  } catch (_) {
    /* 定位 mock 不是登录必需 */
  }
}

module.exports = {
  sleep,
  waitUntil,
  currentPage,
  currentPath,
  wxEval,
  storage,
  systemInfo,
  safeText,
  click,
  gestureTap,
  osTapElement,
  children,
  first,
  deep$,
  deep$$,
  findByText,
  xpath,
  dumpTexts,
  waitPath,
  restoreLeftoverMocks,
};
