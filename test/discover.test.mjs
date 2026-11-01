// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { discover, detectCanonical, codexChains, claudeLaunchSet, claudeImportDepth, resolveReference } from "../src/discover.mjs";
import { claudeImports } from "../src/markdown.mjs";
import { defaultConfig } from "../src/config.mjs";
import { tempTree, run } from "./helpers.mjs";

const AG = "# AGENTS.md\n\n- Rule one that is long enough.\n";

test("taproot-like layout: AGENTS.md canonical by inbound references", () => {
  const t = tempTree({ "AGENTS.md": AG, "CLAUDE.md": "@AGENTS.md\n", ".github/copilot-instructions.md": "Read [AGENTS.md](../AGENTS.md).\n", ".github/instructions/a.instructions.md": '---\napplyTo: "**"\n---\n', "node_modules/x/AGENTS.md": "ignored\n" });
  try {
    const repo = discover(t.root, defaultConfig());
    assert.deepEqual(repo.files.map((f) => f.path), [".github/copilot-instructions.md", ".github/instructions/a.instructions.md", "AGENTS.md", "CLAUDE.md"]);
    const c = detectCanonical(repo, defaultConfig());
    assert.equal(c.canonical, "AGENTS.md");
    assert.equal(c.inbound.get("AGENTS.md"), 2);
  } finally { t.cleanup(); }
});

test("taproot-controls-like layout: the file three pointers agree on", () => {
  const t = tempTree({ "AI_GUIDELINES.md": AG, "AGENTS.md": "See [AI_GUIDELINES.md](AI_GUIDELINES.md).\n", "CLAUDE.md": "See [AI_GUIDELINES.md](AI_GUIDELINES.md).\n", ".github/copilot-instructions.md": "See [AI_GUIDELINES.md](../AI_GUIDELINES.md).\n" });
  try {
    const repo = discover(t.root, defaultConfig());
    assert.equal(detectCanonical(repo, defaultConfig()).canonical, "AI_GUIDELINES.md");
  } finally { t.cleanup(); }
});

test("site-like, trellis-like and empty layouts", () => {
  const site = tempTree({ "AGENTS.md": AG, "CLAUDE.md": "@AGENTS.md\n" });
  const trellis = tempTree({ "AGENTS.md": AG });
  const empty = tempTree({ "README.md": "x\n" });
  try {
    assert.equal(detectCanonical(discover(site.root, defaultConfig()), defaultConfig()).canonical, "AGENTS.md");
    const tr = discover(trellis.root, defaultConfig());
    assert.equal(detectCanonical(tr, defaultConfig()).canonical, "AGENTS.md");
    assert.equal(claudeLaunchSet(tr).fallback, true);
    assert.equal(detectCanonical(discover(empty.root, defaultConfig()), defaultConfig()).canonical, null);
  } finally { site.cleanup(); trellis.cleanup(); empty.cleanup(); }
});

test("configured canonical wins and ignore globs apply", () => {
  const t = tempTree({ "GUIDE.md": AG, "AGENTS.md": AG, "vendor/AGENTS.md": AG });
  try {
    const config = { ...defaultConfig(), canonical: "GUIDE.md", ignore: ["vendor/**"] };
    const repo = discover(t.root, config);
    assert.deepEqual(repo.files.map((f) => f.path), ["AGENTS.md", "GUIDE.md"]);
    assert.equal(detectCanonical(repo, config).canonical, "GUIDE.md");
  } finally { t.cleanup(); }
});

test("codex chains: one file per directory, override wins, empty override contributes nothing", () => {
  const t = tempTree({ "AGENTS.md": AG, "api/AGENTS.md": AG, "api/AGENTS.override.md": "", "web/AGENTS.override.md": "# w\n" });
  try {
    const chains = codexChains(discover(t.root, defaultConfig()));
    const api = chains.find((c) => c.dir === "api");
    assert.ok(api);
    assert.deepEqual(api.entries.map((e) => [e.file, e.bytes, e.shadows]), [["AGENTS.md", AG.length, null], ["api/AGENTS.override.md", 0, "api/AGENTS.md"]]);
    const web = chains.find((c) => c.dir === "web");
    assert.ok(web);
    assert.equal(web.entries.length, 2);
  } finally { t.cleanup(); }
});

test("claude launch set: .claude/CLAUDE.md, rules without paths, imports once, four hops", () => {
  const t = tempTree({
    ".claude/CLAUDE.md": "@../AGENTS.md\n@../docs/a.md\n",
    ".claude/rules/one.md": "rule\n",
    ".claude/rules/scoped.md": "---\npaths:\n  - src/**\n---\nscoped\n",
    "AGENTS.md": AG,
    "docs/a.md": "@b.md\n", "docs/b.md": "@c.md\n", "docs/c.md": "@d.md\n", "docs/d.md": "@e.md\n", "docs/e.md": "deep\n",
  });
  try {
    const launch = claudeLaunchSet(discover(t.root, defaultConfig()));
    const files = launch.entries.map((e) => e.file);
    assert.ok(files.includes(".claude/CLAUDE.md") && files.includes(".claude/rules/one.md") && files.includes("AGENTS.md") && files.includes("docs/d.md"));
    assert.ok(!files.includes(".claude/rules/scoped.md"));
    assert.ok(!files.includes("docs/e.md"));
    assert.equal(launch.tooDeep.length, 1);
    assert.equal(launch.fallback, false);
  } finally { t.cleanup(); }
});

test("resolveReference: links from the root, imports absolute and outside", () => {
  assert.equal(resolveReference(".github/copilot-instructions.md", "../AGENTS.md", "link"), "AGENTS.md");
  assert.equal(resolveReference("docs/x.md", "/AGENTS.md", "link"), "AGENTS.md");
  assert.equal(resolveReference("CLAUDE.md", "/AGENTS.md", "import"), null);
  assert.equal(resolveReference("CLAUDE.md", "~/.claude/x.md", "import"), null);
  assert.equal(resolveReference("CLAUDE.md", "../../x.md", "import"), null);
});

test("the root is the cwd: a run from a subdirectory checks that subdirectory", () => {
  const t = tempTree({ "AGENTS.md": AG, "CLAUDE.md": "@AGENTS.md\n", "sub/README.md": "x\n" });
  try {
    const r = run(["check", "--json"], { cwd: `${t.root}/sub` });
    const j = JSON.parse(r.stdout);
    assert.equal(j.canonical, null);
    assert.equal(r.status, 1);
  } finally { t.cleanup(); }
});

test("an import cycle that closes at hop five is not reported as too deep", () => {
  const t = tempTree({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "@b.md\n", "docs/b.md": "@c.md\n", "docs/c.md": "@d.md\n", "docs/d.md": "@../CLAUDE.md\n" });
  try { assert.equal(claudeLaunchSet(discover(t.root, defaultConfig())).tooDeep.length, 0); } finally { t.cleanup(); }
});

test("a nested file every tool points at can be canonical", () => {
  const t = tempTree({ "AGENTS.md": "See [shared](docs/shared.md).\n", "CLAUDE.md": "@docs/shared.md\n", "docs/shared.md": "# shared\n\n- Rule one that is long enough.\n" });
  try {
    const config = { ...defaultConfig(), extraFiles: ["docs/shared.md"] };
    assert.equal(detectCanonical(discover(t.root, config), config).canonical, "docs/shared.md");
  } finally { t.cleanup(); }
});

test("links into ignored directories are not checked", () => {
  const t = tempTree({ "AGENTS.md": "# a\n\nSee [pkg](node_modules/pkg/README.md) and [vendored](vendor/guide.md).\n", "CLAUDE.md": "@AGENTS.md\n", "good-agent.config.json": '{"ignore":["vendor/**"]}\n' });
  try { assert.equal(run(["check", "--cwd", t.root]).status, 0); } finally { t.cleanup(); }
});

test("imports reached by two paths expand at the shallowest depth; bytes are on-disk bytes", () => {
  const t = tempTree({ "CLAUDE.md": "@docs/a.md\n@docs/d.md\n", "docs/a.md": "@b.md\n", "docs/b.md": "@c.md\n", "docs/c.md": "@d.md\n", "docs/d.md": "@e.md\n", "docs/e.md": "deep\n", "AGENTS.md": "# a\n" });
  try {
    const launch = claudeLaunchSet(discover(t.root, defaultConfig()));
    assert.equal(launch.tooDeep.length, 0);
    assert.ok(launch.entries.some((e) => e.file === "docs/e.md"));
    assert.equal(launch.entries.find((e) => e.file === "docs/d.md")?.depth, 1);
  } finally { t.cleanup(); }
});

test("non-UTF-8 bytes are counted on disk and the ignore check covers every ancestor", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const t = tempTree({ "CLAUDE.md": "@AGENTS.md\n" });
  try {
    writeFileSync(join(t.root, "AGENTS.md"), Buffer.alloc(40000, 0xff));
    const repo = discover(t.root, defaultConfig());
    assert.equal(repo.byPath.get("AGENTS.md")?.bytes, 40000);
  } finally { t.cleanup(); }
  const { isIgnoredTarget } = await import("../src/discover.mjs");
  const config = { ...defaultConfig(), ignore: ["vendor", "third/*"] };
  assert.ok(isIgnoredTarget("packages/app/node_modules/pkg/README.md", config));
  assert.ok(isIgnoredTarget("vendor/guide.md", config));
  assert.ok(isIgnoredTarget("third/party/deep/file.md", config));
  assert.ok(!isIgnoredTarget("docs/guide.md", config));
});

test("Windows absolute imports are skipped; a nested canonical AGENTS.md has the right name; a normalized canonical path", () => {
  assert.equal(resolveReference("CLAUDE.md", "C:/Users/me/guide.md", "import"), null);
  assert.equal(resolveReference("CLAUDE.md", "\\\\server\\share\\x.md", "import"), null);
  assert.equal(resolveReference("sub/CLAUDE.md", ".\\AGENTS.md", "import"), "sub/AGENTS.md");
  const [win] = claudeImports("@.\\my\\ dir\\x.md\n");
  assert.equal(resolveReference("CLAUDE.md", win.target, "import"), "my dir/x.md");
  const t = tempTree({ "api/AGENTS.md": "# api\n\n- Rule one that is long enough.\n", "CLAUDE.md": "@api/AGENTS.md\n", "good-agent.config.json": '{"canonical":"docs/../api/AGENTS.md"}\n' });
  try {
    const r = run(["check", "--json", "--cwd", t.root]);
    const j = JSON.parse(r.stdout);
    assert.equal(j.canonical, "api/AGENTS.md");
    assert.ok(!j.findings.some((/** @type {any} */ f) => f.rule === "canonical/name"), JSON.stringify(j.findings));
    assert.ok(!j.findings.some((/** @type {any} */ f) => f.rule === "claude/import-canonical"), JSON.stringify(j.findings));
  } finally { t.cleanup(); }
});

test("budget diagnostics use on-disk bytes for a non-UTF-8 file", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const t = tempTree({ "CLAUDE.md": "@AGENTS.md\n" });
  try {
    const body = Buffer.concat([Buffer.from("# a\n"), Buffer.alloc(20000, 0xff), Buffer.from(`\n## Later\n${"- line\n".repeat(3000)}`)]);
    writeFileSync(join(t.root, "AGENTS.md"), body);
    const j = JSON.parse(run(["check", "--json", "--cwd", t.root]).stdout);
    const f = j.findings.find((/** @type {any} */ x) => x.rule === "codex/size-budget");
    assert.equal(f.data.lostBytes, body.length - 32768);
    assert.ok(f.line > 2, String(f.line));
    assert.ok(f.message.includes("## Later"), f.message);
  } finally { t.cleanup(); }
});

test("claudeImportDepth follows on-demand Claude files and the rule reports them", () => {
  const t = tempTree({
    "AGENTS.md": AG,
    "sub/CLAUDE.md": "@docs/a.md\n",
    "sub/docs/a.md": "@b.md\n",
    "sub/docs/b.md": "@c.md\n",
    "sub/docs/c.md": "@d.md\n",
    "sub/docs/d.md": "@e.md\n",
    "sub/docs/e.md": "end\n",
  });
  try {
    const repo = discover(t.root, defaultConfig());
    assert.deepEqual(claudeImportDepth(repo, defaultConfig()), [{ file: "sub/docs/e.md", via: "sub/docs/d.md", line: 1 }]);
    const r = run(["check", "--json", "--cwd", t.root]);
    const out = JSON.parse(r.stdout);
    const hits = out.findings.filter((f) => f.rule === "claude/import-depth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "sub/docs/d.md");
  } finally { t.cleanup(); }
});

test("claudeImportDepth counts path-scoped rules and ignores a shorter route", () => {
  const t = tempTree({
    "CLAUDE.md": "@x.md\n@a.md\n",
    ".claude/rules/scoped.md": "---\npaths: src/**\n---\n@r1.md\n",
    "r1.md": "@r2.md\n", "r2.md": "@r3.md\n", "r3.md": "@r4.md\n", "r4.md": "@x.md\n",
    "a.md": "@b.md\n", "b.md": "@x.md\n", "x.md": "end\n",
  });
  try {
    assert.deepEqual(claudeImportDepth(discover(t.root, defaultConfig()), defaultConfig()), []);
  } finally { t.cleanup(); }
});

test("claudeImportDepth starts from the AGENTS.md fallback when there is no CLAUDE.md", () => {
  const t = tempTree({
    "AGENTS.md": "@docs/a.md\n",
    "docs/a.md": "@b.md\n", "docs/b.md": "@c.md\n", "docs/c.md": "@d.md\n", "docs/d.md": "@e.md\n", "docs/e.md": "end\n",
  });
  try {
    assert.deepEqual(claudeImportDepth(discover(t.root, defaultConfig()), defaultConfig()), [{ file: "docs/e.md", via: "docs/d.md", line: 1 }]);
    const j = JSON.parse(run(["check", "--json", "--cwd", t.root]).stdout);
    const hits = j.findings.filter((/** @type {any} */ f) => f.rule === "claude/import-depth");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "docs/d.md");
  } finally { t.cleanup(); }
});
