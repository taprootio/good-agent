// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripCode, parseFrontMatter, markdownLinks, claudeImports, generatedBlocks, generatedBlockAt, countLines, withoutGeneratedBlocks } from "../src/markdown.mjs";

test("stripCode blanks fenced blocks and code spans but keeps line numbers", () => {
  const src = "a\n```\n[x](y)\n```\nb `@c.md` d\n";
  const out = stripCode(src);
  assert.equal(out.split("\n").length, src.split("\n").length);
  assert.ok(!out.includes("[x](y)"));
  assert.ok(!out.includes("@c.md"));
});

test("front matter: flat keys, continuation lines, one nested map", () => {
  const fm = parseFrontMatter("---\nname: x\ndescription: first line\n  second line\nmetadata:\n  package: good-agent\n  owner: je\n---\nbody\n");
  assert.ok(fm);
  assert.equal(fm.data.name, "x");
  assert.equal(fm.data.description, "first line second line");
  assert.deepEqual(fm.data.metadata, { package: "good-agent", owner: "je" });
  assert.equal(fm.errors.length, 0);
});

test("front matter: deeper nesting is an error, quoted values are unquoted, no front matter is null", () => {
  const fm = parseFrontMatter('---\napplyTo: "**/*.ts"\nmetadata:\n  deep:\n    x: 1\n---\n');
  assert.ok(fm);
  assert.equal(fm.data.applyTo, "**/*.ts");
  assert.ok(fm.errors.some((e) => e.includes("deeper than one level")));
  assert.equal(parseFrontMatter("# no front matter\n---\n"), null);
});

test("markdownLinks skips web, mail and anchors and strips fragments", () => {
  const links = markdownLinks("[a](docs/a.md#top) [b](https://x) [c](mailto:x@y) [d](#here) [e](/root.md \"t\")\n");
  assert.deepEqual(links.map((l) => l.target), ["docs/a.md", "/root.md"]);
  assert.equal(links[0].line, 1);
});

test("claudeImports: paths, escaped spaces, not emails, not quoted, not code", () => {
  const src = "@AGENTS.md\nmail me at someone@example.com\n\"@quoted/path.md\"\n@Design\\ Docs/api.md\nping @jereme\n`@AGENTS.md`\n";
  const imports = claudeImports(src).map((i) => i.target);
  assert.deepEqual(imports, ["AGENTS.md", "Design Docs/api.md"]);
});

test("generated blocks and the hand-written exception", () => {
  const src = "x\n<!-- BEGIN TRELLIS -->\na\nb\n<!-- END TRELLIS -->\n<!-- BEGIN GOOD-AGENT -->\nc\n<!-- END GOOD-AGENT -->\n";
  const blocks = generatedBlocks(src);
  assert.deepEqual(blocks.map((b) => [b.name, b.startLine, b.endLine]), [["TRELLIS", 2, 5], ["GOOD-AGENT", 6, 8]]);
  assert.equal(generatedBlockAt(blocks, 3), "TRELLIS");
  assert.equal(generatedBlockAt(blocks, 7), null);
  assert.ok(!withoutGeneratedBlocks(src).includes("\na\n"));
  assert.ok(withoutGeneratedBlocks(src).includes("c"));
});

test("countLines matches wc -l", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
});

test("stripCode: tilde fences, longer fences, double-backtick spans", () => {
  const src = "~~~\n@AGENTS.md\n~~~\n````md\n```\n@X.md\n````\nuse ``@AGENTS.md`` here\n";
  assert.deepEqual(claudeImports(src), []);
});

test("markdownLinks: angle-bracket destinations with spaces, balanced parentheses, titles", () => {
  const links = markdownLinks("[a](<docs/my guide.md>) [b](docs/guide(v2).md) [c](docs/x.md \"title\") [d](docs/y.md 'title')\n");
  assert.deepEqual(links.map((l) => l.target), ["docs/my guide.md", "docs/guide(v2).md", "docs/x.md", "docs/y.md"]);
});

test("code spans across lines, percent-encoded targets, parenthesized titles, stray ]( and BOM", () => {
  assert.deepEqual(claudeImports("Use `example\n@AGENTS.md\nend` here\n"), []);
  assert.deepEqual(markdownLinks("[a](docs/my%20guide.md) [b](missing.md (Guide title)) plain ](nope.md) \\[x](escaped.md)\n").map((l) => l.target), ["docs/my guide.md", "missing.md"]);
  const fm = parseFrontMatter("\uFEFF---\napplyTo: \"**/*.cs\"\n---\n");
  assert.ok(fm && fm.data.applyTo === "**/*.cs");
});
