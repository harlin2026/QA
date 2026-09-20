const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const gdi32 = koffi.load("gdi32.dll");
const kernel32 = koffi.load("kernel32.dll");

const RECT = koffi.struct("RECT", {
  left: "long",
  top: "long",
  right: "long",
  bottom: "long",
});
const POINT = koffi.struct("POINT", {
  x: "long",
  y: "long",
});

const EnumWindowsProc = koffi.proto(
  "bool __stdcall EnumWindowsProc(void *hwnd, intptr lParam)",
);
const EnumWindows = user32.func(
  "bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr lParam)",
);
const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hWnd)");
const GetWindowRect = user32.func(
  "bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)",
);
const GetClientRect = user32.func(
  "bool __stdcall GetClientRect(void *hWnd, _Out_ RECT *lpRect)",
);
const ClientToScreen = user32.func(
  "bool __stdcall ClientToScreen(void *hWnd, _Inout_ POINT *lpPoint)",
);
const GetWindowThreadProcessId = user32.func(
  "uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)",
);
const GetWindowTextW = user32.func(
  "int __stdcall GetWindowTextW(void *hWnd, uint16 *lpString, int nMaxCount)",
);
const GetWindowTextLengthW = user32.func(
  "int __stdcall GetWindowTextLengthW(void *hWnd)",
);
const GetClassNameW = user32.func(
  "int __stdcall GetClassNameW(void *hWnd, uint16 *lpClassName, int nMaxCount)",
);
const EnumChildWindows = user32.func(
  "bool __stdcall EnumChildWindows(void *hWndParent, EnumWindowsProc *lpEnumFunc, intptr lParam)",
);
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func(
  "bool __stdcall SetForegroundWindow(void *hWnd)",
);
const GetWindowDC = user32.func("void * __stdcall GetWindowDC(void *hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)");
const PrintWindow = user32.func(
  "bool __stdcall PrintWindow(void *hwnd, void *hdcBlt, uint32 nFlags)",
);
const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int X, int Y)");
const mouse_event = user32.func(
  "void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)",
);
const keybd_event = user32.func(
  "void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)",
);
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 nInputs, void *pInputs, int cbSize)");
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(void *hWnd, void *hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)",
);

const OpenProcess = kernel32.func(
  "void * __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)",
);
const QueryFullProcessImageNameW = kernel32.func(
  "bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, uint16 *lpExeName, _Inout_ uint32 *lpdwSize)",
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *hObject)");

const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func(
  "void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)",
);
const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)");
const DeleteObject = gdi32.func("bool __stdcall DeleteObject(void *ho)");
const DeleteDC = gdi32.func("bool __stdcall DeleteDC(void *hdc)");
const GetDIBits = gdi32.func(
  "int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 cLines, void *lpvBits, void *lpbmi, uint32 usage)",
);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const VK_MENU = 0x12;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const PW_RENDERFULLCONTENT = 2;
const INPUT_MOUSE = 0;
const INPUT_SIZE = 40;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUtf16(buf) {
  return buf.toString("utf16le").replace(/\0/g, "");
}

function processPath(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return "";
  try {
    const buf = Buffer.alloc(1024 * 2);
    const size = [1024];
    const ok = QueryFullProcessImageNameW(handle, 0, buf, size);
    return ok ? readUtf16(buf) : "";
  } finally {
    CloseHandle(handle);
  }
}

function windowTitle(hwnd) {
  const len = GetWindowTextLengthW(hwnd);
  const max = Math.max(len + 1, 2);
  const buf = Buffer.alloc(max * 2);
  GetWindowTextW(hwnd, buf, max);
  return readUtf16(buf);
}

function windowClass(hwnd) {
  const buf = Buffer.alloc(512);
  GetClassNameW(hwnd, buf, 256);
  return readUtf16(buf);
}

function isBlockedApp(exe, title, cls) {
  return /WXWork|WeCom|WeChatLogin|PerryShadow|GameViewer|UU远程|TextInputHost|Cursor\.exe|MobaXterm|ApplicationFrameHost|SystemSettings/i.test(
    `${exe}\n${title}\n${cls}`,
  );
}

function isDevToolsApp(exe, title) {
  return /微信开发者工具|wechatwebdevtools|wechatdevtools/i.test(`${exe}\n${title}`);
}

function looksLikeDevTools(exe, title, cls) {
  if (isBlockedApp(exe, title, cls)) return false;
  if (isDevToolsApp(exe, title)) return true;
  const blob = `${exe}\n${title}\n${cls}`;
  return /wechatweb|package\.nw/i.test(blob) || /MiniProgram|模拟器|aChill Club/i.test(title);
}

function isPhoneShape(width, height) {
  return width >= 250 && width <= 620 && height >= 400 && height <= 1600;
}

function collectWindow(hwnd, found, seen) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  const exe = processPath(pid[0]);
  const title = windowTitle(hwnd);
  const cls = windowClass(hwnd);
  if (isBlockedApp(exe, title, cls)) return;
  const visible = !!IsWindowVisible(hwnd);
  const fromDevTools = isDevToolsApp(exe, title) || looksLikeDevTools(exe, title, cls);
  if (!visible && !fromDevTools) return;
  const rect = {};
  GetWindowRect(hwnd, rect);
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width < 80 || height < 80) return;
  if (rect.left < -1000 || rect.top < -1000) return;
  if (seen) {
    seen.push({
      width,
      height,
      left: rect.left,
      top: rect.top,
      title: String(title || "").slice(0, 40),
      cls: String(cls || "").slice(0, 32),
      exe: path.basename(exe || ""),
      visible,
    });
  }
  if (width < 220 || height < 360) return;
  const phoneLike = isPhoneShape(width, height);
  if (!fromDevTools && !phoneLike) return;
  found.push({
    area: width * height,
    hwnd,
    width,
    height,
    left: rect.left,
    top: rect.top,
    title,
    fromDevTools,
    phoneLike,
    visible,
    skip: /Project List/i.test(title || ""),
    score: phoneLike ? width * height : width * height + 10_000_000,
  });
}

function pickSimulator(found) {
  if (!found.length) return null;
  const usable = found.filter((item) => !item.skip);
  const pool = usable.length ? usable : found;
  const phones = pool.filter((item) => item.fromDevTools && item.phoneLike);
  if (phones.length) {
    phones.sort((a, b) => b.height - a.height || a.score - b.score);
    return phones[0];
  }
  const dev = pool.filter((item) => item.fromDevTools);
  if (dev.length) {
    dev.sort((a, b) => Number(b.visible) - Number(a.visible) || b.area - a.area);
    return dev[0];
  }
  return null;
}

function findSimulatorHwnd(quiet = false) {
  const found = [];
  const seen = [];
  const callback = koffi.register((hwnd) => {
    collectWindow(hwnd, found, seen);
    return true;
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(callback, 0);
    const parents = [];
    const parentCb = koffi.register((hwnd) => {
      const title = windowTitle(hwnd);
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      const exe = processPath(pid[0]);
      const cls = windowClass(hwnd);
      const rect = {};
      GetWindowRect(hwnd, rect);
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      if (isDevToolsApp(exe, title) || looksLikeDevTools(exe, title, cls) || (width >= 700 && height >= 500 && IsWindowVisible(hwnd))) {
        parents.push(hwnd);
      }
      return true;
    }, koffi.pointer(EnumWindowsProc));
    try {
      EnumWindows(parentCb, 0);
    } finally {
      koffi.unregister(parentCb);
    }
    for (const parent of parents) {
      EnumChildWindows(parent, callback, 0);
    }
  } finally {
    koffi.unregister(callback);
  }

  const win = pickSimulator(found);
  if (!win) {
    if (!quiet) {
      console.log(">>> 未找到模拟器窗口");
      const notable = seen
        .filter((item) => item.width >= 200 && item.height >= 300)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 12);
      for (const item of notable) {
        console.log(
          `>>>   窗口${item.visible ? "" : "(隐藏)"} ${item.width}x${item.height} @(${item.left},${item.top}) ${item.exe} [${item.cls}] ${item.title}`,
        );
      }
    }
    return null;
  }
  if (!quiet) {
    console.log(
      `>>> 模拟器窗口${win.visible ? "" : "(隐藏已唤出)"} ${win.width}x${win.height} @(${win.left},${win.top}) ${win.title || ""}`,
    );
  }
  ShowWindow(win.hwnd, SW_SHOW);
  ShowWindow(win.hwnd, SW_RESTORE);
  SetForegroundWindow(win.hwnd);
  return win;
}

function captureWindow(win) {
  const { hwnd, width, height } = win;
  const hdc = GetWindowDC(hwnd);
  const mem = CreateCompatibleDC(hdc);
  const bmp = CreateCompatibleBitmap(hdc, width, height);
  const old = SelectObject(mem, bmp);
  PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT);

  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(width, 4);
  bmi.writeInt32LE(-height, 8);
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);

  const pixels = Buffer.alloc(width * height * 4);
  GetDIBits(mem, bmp, 0, height, pixels, bmi, 0);

  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  ReleaseDC(hwnd, hdc);
  return { pixels, width, height };
}

function pixelAt(pixels, width, x, y) {
  const i = (y * width + x) * 4;
  return {
    b: pixels[i],
    g: pixels[i + 1],
    r: pixels[i + 2],
  };
}

function clusterGreenButtons(win, quiet = false) {
  const { pixels, width, height } = captureWindow(win);
  const rows = [];
  const y0 = Math.floor(height * 0.5);
  const y1 = Math.floor(height * 0.95);
  const x0 = Math.floor(width * 0.08);
  const x1 = Math.floor(width * 0.96);
  for (let y = y0; y < y1; y += 1) {
    let runStart = null;
    for (let x = x0; x < x1; x += 1) {
      const { r, g, b } = pixelAt(pixels, width, x, y);
      const isWxGreen = g >= 120 && r <= 110 && g - r >= 40 && g > b + 20;
      if (isWxGreen) {
        if (runStart === null) runStart = x;
      } else if (runStart !== null) {
        const runW = x - runStart;
        if (runW >= 20 && runW <= 220) rows.push([y, runStart, x]);
        runStart = null;
      }
    }
    if (runStart !== null) {
      const runW = x1 - runStart;
      if (runW >= 20 && runW <= 220) rows.push([y, runStart, x1]);
    }
  }

  const clusters = [];
  if (rows.length) {
    let current = [rows[0]];
    for (const row of rows.slice(1)) {
      if (row[0] - current[current.length - 1][0] <= 12) current.push(row);
      else {
        clusters.push(current);
        current = [row];
      }
    }
    clusters.push(current);
  }

  const hits = [];
  for (const cluster of clusters) {
    const cy1 = cluster[0][0];
    const cy2 = cluster[cluster.length - 1][0];
    const cx1 = Math.min(...cluster.map((item) => item[1]));
    const cx2 = Math.max(...cluster.map((item) => item[2]));
    const btnW = cx2 - cx1;
    const btnH = cy2 - cy1 + 1;
    hits.push({
      btnW,
      btnH,
      x: win.left + Math.floor((cx1 + cx2) / 2),
      y: win.top + Math.floor((cy1 + cy2) / 2),
      relX: (cx1 + cx2) / 2 / width,
    });
  }
  if (!quiet) {
    console.log(
      `>>> 绿色块 行数=${rows.length} 簇=${hits.map((item) => `${item.btnW}x${item.btnH}@${item.x},${item.y}`).join(" | ") || "无"}`,
    );
  }
  hits.sort((a, b) => b.relX - a.relX);
  return hits.filter((item) => item.btnW >= 18 && item.btnW <= 240 && item.btnH >= 4 && item.btnH <= 100);
}

function allowButtonPoints(win) {
  const ratios = [
    [0.5, 0.68],
    [0.72, 0.82],
    [0.64, 0.817],
    [0.59, 0.817],
    [0.75, 0.85],
  ];
  return ratios.map(([rx, ry], index) => ({
    x: win.left + Math.floor(win.width * rx),
    y: win.top + Math.floor(win.height * ry),
    label: index === 0 ? "手机号" : `允许候选${index}`,
  }));
}

let skipUia = false;

function pickAllowHit(hits, win) {
  if (!hits.length) return null;
  const typical = hits.filter((item) => item.btnW >= 40 && item.btnW <= 120 && item.btnH >= 10 && item.btnH <= 40);
  const pool = typical.length ? typical : hits;
  if (win.width > 620) {
    const left = pool.filter((item) => item.relX <= 0.5);
    const source = left.length ? left : pool;
    source.sort((a, b) => b.relX - a.relX);
    return source[0];
  }
  return pool.find((item) => item.relX >= 0.45) || pool[0];
}

function clickGreenAllow(win, quiet = false) {
  if (!win) return null;
  const hits = clusterGreenButtons(win, quiet);
  const allow = pickAllowHit(hits, win);
  if (!allow) return null;
  if (!quiet) {
    console.log(`>>> 模拟器内允许按钮 ${allow.btnW}x${allow.btnH} -> 屏幕(${allow.x},${allow.y})`);
  }
  return { x: allow.x, y: allow.y, win };
}

function runPythonAllow(timeout = 2500) {
  const script = path.resolve(__dirname, "..", "tools", "click_allow.py");
  const venvPy = path.resolve(__dirname, "..", ".venv", "Scripts", "python.exe");
  const py = fs.existsSync(venvPy) ? venvPy : "python";
  if (!fs.existsSync(script)) {
    return { out: "", status: 1 };
  }
  const result = spawnSync(py, [script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (out) {
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) console.log(`>>> ${line.trim()}`);
    }
  }
  if (result.error) {
    const message = result.error.message || String(result.error);
    console.log(`>>> click_allow 进程错误：${message}`);
    if (/ETIMEDOUT|ETIMEOUT|timed out/i.test(message)) {
      skipUia = true;
      console.log(">>> UI Automation 卡住，之后改用截图点绿色「允许」");
    }
  }
  return { out, status: result.status || 0 };
}

function uiaClickAllow() {
  if (skipUia) return false;
  console.log(">>> 用 UI Automation 点击原生「允许」");
  const { out, status } = runPythonAllow(2500);
  if (status) console.log(`>>> click_allow 退出码 ${status}`);
  return /CLICKED_ALLOW|已点击：允许/i.test(out);
}

async function clickAllowInSimulator() {
  const win = findSimulatorHwnd();
  if (win) {
    bringToFront(win.hwnd);
    await sleep(180);
    const green = clickGreenAllow(win);
    if (green) {
      await osClickXy(green.x, green.y, "允许");
      return true;
    }
  }

  if (uiaClickAllow()) return true;

  const again = findSimulatorHwnd(true);
  if (again) {
    const green = clickGreenAllow(again);
    if (green) {
      await osClickXy(green.x, green.y, "允许");
      return true;
    }
    for (const point of allowButtonPoints(again).slice(0, 3)) {
      await osClickXy(point.x, point.y, point.label);
      await sleep(220);
    }
    return true;
  }
  console.log(">>> 未能点击「允许」：找不到模拟器窗口");
  return false;
}

function bringToFront(hwnd) {
  if (!hwnd) return;
  ShowWindow(hwnd, SW_SHOW);
  ShowWindow(hwnd, SW_RESTORE);
  keybd_event(VK_MENU, 0, 0, 0);
  SetForegroundWindow(hwnd);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
}

function sendInputClick() {
  const buf = Buffer.alloc(INPUT_SIZE * 2);
  buf.writeUInt32LE(INPUT_MOUSE, 0);
  buf.writeUInt32LE(MOUSEEVENTF_LEFTDOWN, 20);
  buf.writeUInt32LE(INPUT_MOUSE, INPUT_SIZE);
  buf.writeUInt32LE(MOUSEEVENTF_LEFTUP, INPUT_SIZE + 20);
  return SendInput(2, buf, INPUT_SIZE);
}

function mouseEventAbsolute(x, y, flags) {
  const screenW = Math.max(GetSystemMetrics(0), 1);
  const screenH = Math.max(GetSystemMetrics(1), 1);
  const absX = Math.round((x * 65535) / screenW);
  const absY = Math.round((y * 65535) / screenH);
  mouse_event(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE | flags, absX, absY, 0, 0);
}

async function osClickXy(x, y, label) {
  const win = findSimulatorHwnd(true);
  if (win) bringToFront(win.hwnd);
  const px = Math.round(x);
  const py = Math.round(y);
  SetCursorPos(px, py);
  await sleep(120);
  mouseEventAbsolute(px, py, MOUSEEVENTF_LEFTDOWN);
  await sleep(60);
  mouseEventAbsolute(px, py, MOUSEEVENTF_LEFTUP);
  SetCursorPos(px, py);
  sendInputClick();
  await sleep(60);
  mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
  await sleep(40);
  mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  console.log(`>>> 系统鼠标点击「${label}」(${px},${py})`);
  return true;
}

async function osSwipe(x1, y1, x2, y2, steps = 14) {
  SetCursorPos(Math.round(x1), Math.round(y1));
  await sleep(80);
  mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
  for (let step = 1; step <= steps; step += 1) {
    const x = x1 + ((x2 - x1) * step) / steps;
    const y = y1 + ((y2 - y1) * step) / steps;
    SetCursorPos(Math.round(x), Math.round(y));
    await sleep(20);
  }
  mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  return true;
}

async function swipeStoreList() {
  const win = findSimulatorHwnd(true);
  if (!win) return false;
  const listX = win.left + Math.floor(win.width * 0.48);
  const y1 = win.top + Math.floor(win.height * 0.78);
  const y2 = win.top + Math.floor(win.height * 0.32);
  console.log(">>> 上滑门店列表，寻找澳门直营店");
  await osSwipe(listX, y1, listX, y2, 16);
  const barX = win.left + win.width - 10;
  const barY1 = win.top + Math.floor(win.height * 0.4);
  const barY2 = win.top + Math.floor(win.height * 0.86);
  console.log(">>> 拖动右侧滚动条往下，寻找澳门直营店");
  return osSwipe(barX, barY1, barX, barY2, 18);
}

async function clickPageXy(pageX, pageY, label, systemInfo = {}) {
  const win = findSimulatorHwnd(true);
  if (!win) return false;
  const client = {};
  GetClientRect(win.hwnd, client);
  const origin = { x: 0, y: 0 };
  ClientToScreen(win.hwnd, origin);
  const cw = Math.max(client.right - client.left, 1);
  const ch = Math.max(client.bottom - client.top, 1);
  const pageW = Number(systemInfo.windowWidth || systemInfo.screenWidth || 390);
  const pageH = Number(systemInfo.windowHeight || systemInfo.screenHeight || 844);
  const sx = origin.x + Math.floor((pageX * cw) / Math.max(pageW, 1));
  const sy = origin.y + Math.floor((pageY * ch) / Math.max(pageH, 1));
  return osClickXy(sx, sy, label);
}

module.exports = {
  sleep,
  findSimulatorHwnd,
  clickAllowInSimulator,
  osClickXy,
  swipeStoreList,
  clickPageXy,
};
