const h = require("./helper");

const PAGE_SETUP = `
  function __pageSetup() {
    const page = getCurrentPages().slice(-1)[0];
    const vm = page && (page.$vm || page);
    const inner = vm && vm.$;
    const candidates = [
      inner && inner.proxy,
      inner && inner.exposed,
      inner && inner.setupState,
      inner && inner.ctx,
      vm && vm.$vm,
      vm,
      page
    ].filter(Boolean);
    const unwrap = function (value) {
      return value && typeof value === 'object' && 'value' in value ? value.value : value;
    };
    const getRef = function (key) {
      for (let i = 0; i < candidates.length; i += 1) {
        const cur = candidates[i][key];
        if (cur !== undefined && cur !== null) return unwrap(cur);
      }
      return '';
    };
    const setRef = function (key, val) {
      for (let i = 0; i < candidates.length; i += 1) {
        const t = candidates[i];
        const cur = t[key];
        if (cur && typeof cur === 'object' && 'value' in cur) {
          cur.value = val;
          return;
        }
      }
      if (candidates[0]) candidates[0][key] = val;
    };
    const callFn = function (name, arg) {
      for (let i = 0; i < candidates.length; i += 1) {
        const fn = candidates[i][name];
        if (typeof fn === 'function') {
          fn(arg);
          return true;
        }
      }
      return false;
    };
    return { page: page, vm: vm, state: candidates[0] || {}, unwrap: unwrap, getRef: getRef, setRef: setRef, callFn: callFn };
  }
`;

async function pageEval(miniProgram, source) {
  return h.wxEval(miniProgram, `${PAGE_SETUP}\n${source}`);
}

module.exports = { pageEval };
