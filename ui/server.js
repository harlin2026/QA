const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ROUTES, resolveRoute } = require("../src/routes");
const { listMemberCases } = require("../src/member-suite");
const { listCoverageCases } = require("../src/coverage-suite");
const { buildCatalog } = require("../src/catalog");
const { publicConfig, saveConfig } = require("../src/config");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.QA_UI_PORT || publicConfig().tools.uiPort || 3780);

const clients = new Set();
const recent = [];
const RECENT_LIMIT = 400;

let child = null;
let running = false;
let currentRoute = "";
let currentCase = "";
let lastExit = null;

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const res of clients) {
    try {
      res.write(frame);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function parseQaLine(line) {
  const match = String(line).match(/^>>> (QA_CASES|QA_RESULT|QA_SUITE)\s+(.*)$/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[2]);
    const at = Date.now();
    if (match[1] === "QA_CASES") return { type: "cases", cases: data, at };
    if (match[1] === "QA_RESULT") return { type: "result", item: data, at };
    return { type: "suite", summary: data, at };
  } catch (_) {
    return null;
  }
}

function logLine(stream, chunk) {
  const text = String(chunk || "").replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const event = {
      type: "log",
      stream,
      line,
      at: Date.now(),
    };
    broadcast(event);
    const qa = parseQaLine(line);
    if (qa) broadcast(qa);
    const prefix = stream === "stderr" ? "[err] " : "";
    process.stdout.write(`${prefix}${line}\n`);
  }
}

function stopRun() {
  if (!child || child.killed) return false;
  const pid = child.pid;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      child.kill("SIGTERM");
    } catch (_) {
      /* ignore */
    }
  }
  return true;
}

function startRun(routeId, caseId) {
  if (running) {
    const error = new Error("已有测试在跑");
    error.code = 409;
    throw error;
  }
  const route = resolveRoute(routeId);
  const onlyCase = String(caseId || "").trim();
  running = true;
  currentRoute = route.id;
  currentCase = onlyCase;
  lastExit = null;
  broadcast({
    type: "start",
    route: route.id,
    case: onlyCase,
    label: onlyCase ? `${route.label} · ${onlyCase}` : route.label,
    at: Date.now(),
  });
  if (route.id === "member" || route.id === "member-only") {
    broadcast({ type: "cases", cases: listMemberCases(onlyCase || undefined), at: Date.now() });
  }
  if (route.id === "coverage-only") {
    broadcast({ type: "cases", cases: listCoverageCases(onlyCase || undefined), at: Date.now() });
  }

  const args = [path.join(root, "run.js"), `--route=${route.id}`];
  if (onlyCase) args.push(`--case=${onlyCase}`);
  child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      QA_ROUTE: route.id,
      QA_CASE: onlyCase,
      QA_UI: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => logLine("stdout", chunk));
  child.stderr.on("data", (chunk) => logLine("stderr", chunk));
  child.on("error", (error) => {
    logLine("stderr", error.message || String(error));
  });
  child.on("close", (code, signal) => {
    running = false;
    child = null;
    lastExit = { code, signal };
    broadcast({
      type: "end",
      route: route.id,
      case: onlyCase,
      label: route.label,
      code,
      signal,
      ok: code === 0,
      at: Date.now(),
    });
    currentCase = "";
  });

  return route;
}

function mime(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function serveFile(urlPath, res) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicDir, relative));
  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime(filePath), "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/api/tree") {
    send(res, 200, { groups: buildCatalog() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/routes") {
    send(res, 200, { routes: ROUTES });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cases") {
    send(res, 200, { cases: [...listMemberCases(), ...listCoverageCases()] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    send(res, 200, { running, route: currentRoute, case: currentCase, lastExit });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    for (const event of recent) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "status", running, route: currentRoute, case: currentCase, lastExit, at: Date.now() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    send(res, 200, publicConfig());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/config") {
    try {
      const body = await readBody(req);
      send(res, 200, { ok: true, config: saveConfig(body) });
    } catch (error) {
      send(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    try {
      const body = await readBody(req);
      const route = startRun(body.route || "member", body.case);
      send(res, 200, { ok: true, route, case: body.case || "" });
    } catch (error) {
      send(res, error.code === 409 ? 409 : 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const stopped = stopRun();
    send(res, 200, { ok: true, stopped });
    return;
  }

  if (req.method === "GET") {
    serveFile(url.pathname, res);
    return;
  }

  send(res, 404, "not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QA 控制台：http://127.0.0.1:${PORT}`);
});
