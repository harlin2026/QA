const h = require("./helper");

const ERROR_TEXT = /页面不存在|页面错误|出错了|出错啦|系统错误|渲染错误|TypeError|Cannot read|undefined is not|未找到页面/;
const HARD_ERROR = /渲染层错误|Uncaught|TypeError|ReferenceError|未找到页面|页面不存在/;
const FAIL_TOAST = /失败|錯誤|错误|出错|Request failed|Network error|页面不存在|未找到页面|系统错误|Invalid server/;

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

async function installUiHooks(miniProgram) {
  await h.wxEval(
    miniProgram,
    `
      if (wx.__qaHooks) return true;
      wx.__qaHooks = true;
      wx.__qaLog = { toasts: [], modals: [], requests: [] };
      const originToast = wx.showToast;
      wx.showToast = function (opt) {
        try { wx.__qaLog.toasts.push({ title: (opt && opt.title) || '', icon: (opt && opt.icon) || '', at: Date.now() }); } catch (e) {}
        return originToast.apply(this, arguments);
      };
      const originModal = wx.showModal;
      wx.showModal = function (opt) {
        try {
          wx.__qaLog.modals.push({
            title: (opt && opt.title) || '',
            content: (opt && opt.content) || '',
            at: Date.now()
          });
        } catch (e) {}
        return originModal.apply(this, arguments);
      };
      const originReq = wx.request;
      wx.request = function (opt) {
        const options = opt || {};
        const origFail = options.fail;
        const origSuccess = options.success;
        options.fail = function (err) {
          try {
            wx.__qaLog.requests.push({
              url: options.url || '',
              fail: true,
              errMsg: (err && err.errMsg) || String(err || '')
            });
          } catch (e) {}
          if (origFail) origFail(err);
        };
        options.success = function (res) {
          const code = res && res.statusCode;
          let bizCode = '';
          try {
            const data = res && res.data;
            bizCode = data && (data.code || data.errCode || '');
          } catch (e) {}
          if (code >= 400 || bizCode === 500 || bizCode === '500') {
            try {
              wx.__qaLog.requests.push({
                url: options.url || '',
                statusCode: code,
                bizCode: bizCode,
                fail: false
              });
            } catch (e) {}
          }
          if (origSuccess) origSuccess(res);
        };
        return originReq.call(this, options);
      };
      return true;
    `,
  );
}

async function drainUiLog(miniProgram) {
  try {
    return await h.wxEval(
      miniProgram,
      `
        const log = wx.__qaLog || { toasts: [], modals: [], requests: [] };
        wx.__qaLog = { toasts: [], modals: [], requests: [] };
        return log;
      `,
    );
  } catch (_) {
    return { toasts: [], modals: [], requests: [] };
  }
}

async function scanPageErrors(miniProgram) {
  try {
    const page = await h.currentPage(miniProgram);
    const nodes = await h.deep$$(page, "text");
    const texts = [];
    for (const node of nodes.slice(0, 60)) {
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

function classifyUiLog(log, options = {}) {
  const expectToast = options.expectToast;
  const ignoreToast = options.ignoreToast;
  const errors = [];
  const toasts = (log && log.toasts) || [];
  const requests = (log && log.requests) || [];
  const modals = (log && log.modals) || [];

  for (const toast of toasts) {
    const title = String(toast.title || "");
    if (!title) continue;
    if (expectToast && expectToast.test(title)) continue;
    if (ignoreToast && ignoreToast.test(title)) continue;
    if (FAIL_TOAST.test(title)) {
      errors.push(`弹窗：${title}`);
      console.log(`>>> 捕获失败弹窗：${title}`);
    }
  }

  for (const modal of modals) {
    const text = `${modal.title || ""} ${modal.content || ""}`;
    if (ERROR_TEXT.test(text) || FAIL_TOAST.test(text)) {
      errors.push(`对话框：${text.trim().slice(0, 120)}`);
    }
  }

  for (const req of requests) {
    if (req.fail) {
      errors.push(`后台请求失败：${req.url || ""} ${req.errMsg || ""}`.trim().slice(0, 180));
      console.log(`>>> 后台请求失败：${req.url} ${req.errMsg || ""}`);
    } else if (Number(req.statusCode) >= 400) {
      errors.push(`后台 ${req.statusCode}：${req.url || ""}`.slice(0, 180));
      console.log(`>>> 后台 HTTP ${req.statusCode}：${req.url}`);
    }
  }

  return errors;
}

function toastMatched(log, pattern) {
  if (!pattern) return true;
  return ((log && log.toasts) || []).some((item) => pattern.test(String(item.title || "")));
}

module.exports = {
  ERROR_TEXT,
  HARD_ERROR,
  FAIL_TOAST,
  stringify,
  attachWatch,
  installUiHooks,
  drainUiLog,
  scanPageErrors,
  classifyUiLog,
  toastMatched,
};
