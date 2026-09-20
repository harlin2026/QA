const { connectMiniProgram, disconnectQuietly } = require("./src/session");
const { runFlow } = require("./src/flow");
const { resolveRoute } = require("./src/routes");

function parseArg(name, envKey, fallback = "") {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  const flag = process.argv.indexOf(`--${name}`);
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  return process.env[envKey] || fallback;
}

async function main() {
  const route = resolveRoute(parseArg("route", "QA_ROUTE", "member"));
  const caseId = parseArg("case", "QA_CASE");
  let miniProgram;
  try {
    miniProgram = await connectMiniProgram();
    await runFlow(miniProgram, { route: route.id, caseId });
    console.log(`>>> 测试完成：${route.label}${caseId ? " / " + caseId : ""}`);
  } finally {
    await disconnectQuietly(miniProgram);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
