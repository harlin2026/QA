function emitCases(cases) {
  console.log(`>>> QA_CASES ${JSON.stringify(cases)}`);
}

function emitResult(result) {
  console.log(`>>> QA_RESULT ${JSON.stringify(result)}`);
}

function emitSuite(summary) {
  console.log(`>>> QA_SUITE ${JSON.stringify(summary)}`);
}

module.exports = { emitCases, emitResult, emitSuite };
