const { connectMiniProgram, disconnectQuietly } = require("./src/session");
const { runFlow } = require("./src/flow");

async function main() {
  let miniProgram;
  try {
    miniProgram = await connectMiniProgram();
    await runFlow(miniProgram);
    console.log(">>> 测试完成");
  } finally {
    await disconnectQuietly(miniProgram);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
