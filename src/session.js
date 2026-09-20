const { spawn } = require("child_process");
const net = require("net");
const automator = require("miniprogram-automator");
const config = require("./config");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" }, () => {
      sock.end();
      resolve(true);
    });
    sock.setTimeout(800, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
}

async function waitForPort(port, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await sleep(1000);
  }
  return false;
}

function enableAutoPort() {
  const command = `"${config.cliPath}" auto --project "${config.projectPath}" --auto-port ${config.testPort}`;
  console.log(`>>> 执行：${command}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`无法启动 cli.bat：${error.message}`));
    });
    child.on("exit", (code) => {
      if (output.trim()) console.log(output.trim());
      if (code && code !== 0) {
        reject(new Error(`cli.bat 退出码 ${code}${output ? `：${output.trim()}` : ""}`));
        return;
      }
      resolve();
    });
  });
}

async function connectMiniProgram() {
  if (await portOpen(config.testPort)) {
    console.log(">>> 端口已被占用，直连现有会话");
    return automator.connect({
      wsEndpoint: `ws://127.0.0.1:${config.testPort}`,
    });
  }

  console.log(">>> 用 cli.bat 打开自动化端口，开发者工具保持打开");
  try {
    await enableAutoPort();
  } catch (error) {
    console.log(`>>> cli 调用失败，继续等待端口：${error.message}`);
  }

  if (!(await waitForPort(config.testPort, 120000))) {
    throw new Error(
      `连不上自动化端口 ${config.testPort}。请先打开微信开发者工具，设置里打开「服务端口」，再运行 npm test`,
    );
  }

  console.log(`>>> 已连上 ws://127.0.0.1:${config.testPort}`);
  return automator.connect({
    wsEndpoint: `ws://127.0.0.1:${config.testPort}`,
  });
}

function disconnectQuietly(miniProgram) {
  if (!miniProgram) return;
  try {
    miniProgram.disconnect();
  } catch (_) {
    /* 保持开发者工具打开 */
  }
}

module.exports = {
  connectMiniProgram,
  disconnectQuietly,
};
