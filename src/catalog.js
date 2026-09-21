const { ROUTES } = require("./routes");
const { listMemberCases } = require("./member-suite");
const { listCoverageCases } = require("./coverage-suite");

function buildCatalog() {
  const e2eItems = ROUTES.filter((item) => !item.isolated).map((item) => ({
    id: item.id,
    label: item.label,
    summary: item.summary,
    run: item.id,
    kind: "route",
    status: "idle",
  }));

  ROUTES.filter((item) => item.isolated && item.id !== "member-only" && item.id !== "coverage-only").forEach((item) => {
    e2eItems.push({
      id: item.id,
      label: item.label,
      summary: item.summary,
      run: item.id,
      kind: "route",
      status: "idle",
    });
  });

  const groups = [
    {
      id: "e2e",
      label: "端到端",
      items: e2eItems,
    },
  ];

  const byGroup = new Map();
  [...listMemberCases(), ...listCoverageCases()].forEach((item) => {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push({
      id: item.id,
      label: item.name,
      summary: "",
      run: item.run,
      kind: "case",
      status: item.status || "idle",
      error: "",
      path: "",
    });
  });

  byGroup.forEach((items, label) => {
    groups.push({
      id: label,
      label,
      items,
    });
  });

  return groups;
}

module.exports = { buildCatalog };
