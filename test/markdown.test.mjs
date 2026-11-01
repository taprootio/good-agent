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
  assert.deepEqual({ ...fm.data.metadata }, { package: "good-agent", owner: "je" });
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

test("spans do not cross paragraphs, escaped backticks and brackets are literal", () => {
  assert.deepEqual(markdownLinks("`a\n\n[guide](missing.md)\n\nb`\n").map((l) => l.target), ["missing.md"]);
  assert.deepEqual(markdownLinks("\\`not code [x](a.md)\n").map((l) => l.target), ["a.md"]);
  assert.deepEqual(markdownLinks("[label\\](missing.md) and [ok](b.md)\n").map((l) => l.target), ["b.md"]);
  assert.deepEqual(markdownLinks("[label\\\\](c.md)\n").map((l) => l.target), ["c.md"]);
});

test("spans stop at CRLF paragraph breaks and headings; a doubled backslash does not escape a backtick; wrapped titles", () => {
  assert.deepEqual(markdownLinks("`a\r\n\r\n[x](missing.md)\r\n\r\nb`\r\n").map((l) => l.target), ["missing.md"]);
  assert.deepEqual(markdownLinks("`a\n# Heading [y](h.md)\nb`\n").map((l) => l.target), ["h.md"]);
  assert.deepEqual(claudeImports("\\\\`@AGENTS.md` text\n"), []);
  assert.deepEqual(markdownLinks("[a](docs/a.md \"a title that\nwraps\")\n").map((l) => l.target), ["docs/a.md"]);
});

test("a heading is its own block; list items start blocks; deeper nesting and __proto__ keys are rejected; unterminated titles are bounded", () => {
  assert.deepEqual(markdownLinks("# `heading\n[x](missing.md)`\n").map((l) => l.target), ["missing.md"]);
  assert.deepEqual(markdownLinks("- `a\n- [y](item.md)`\n").map((l) => l.target), ["item.md"]);
  const deep = parseFrontMatter('---\napplyTo: "**"\nmetadata:\n  x: y\n    z: q\n---\n');
  assert.ok(deep && deep.errors.length > 0);
  const proto = parseFrontMatter('---\n__proto__:\n  applyTo: "**"\n---\n');
  assert.ok(proto && proto.errors.length > 0 && !Object.hasOwn(proto.data, "applyTo") && proto.data.applyTo === undefined);
  const started = Date.now();
  markdownLinks(`[x](missing.md "${"a\n".repeat(400)}`);
  assert.ok(Date.now() - started < 1000, "title scan must be linear");
});

test("a thematic break ends an inline code block, so a stray backtick does not span it", () => {
  assert.deepEqual(markdownLinks("`before\n***\n[x](missing.md)`\n").map((l) => l.target), ["missing.md"]);
  assert.deepEqual(markdownLinks("`before\n- - -\n[x](missing.md)`\n").map((l) => l.target), ["missing.md"]);
});

test("a table row is its own block and code spans are blanked per cell", () => {
  assert.deepEqual(markdownLinks("| a ` | [x](missing.md) ` |\n").map((l) => l.target), ["missing.md"]);
  assert.deepEqual(markdownLinks("| `a | b` | [x](kept.md) |\n").map((l) => l.target), ["kept.md"]);
});

test("a normal paragraph still blanks a span across lines and keeps the link outside it", () => {
  assert.deepEqual(markdownLinks("`a\nb` [y](z.md)\n").map((l) => l.target), ["z.md"]);
  assert.deepEqual(markdownLinks("`a\n[x](hidden.md)\nb` [y](z.md)\n").map((l) => l.target), ["z.md"]);
});

test("a fence inside a blockquote hides its content; a plain quoted link is kept", () => {
  const src = "> ~~~\n> [x](missing.md)\n> @AGENTS.md\n> ~~~\n";
  assert.deepEqual(markdownLinks(src), []);
  assert.deepEqual(claudeImports(src), []);
  assert.equal(stripCode(src).split("\n").length, src.split("\n").length);
  assert.deepEqual(markdownLinks("> [y](q.md)\n").map((l) => l.target), ["q.md"]);
});

test("a quoted fence closes only at the same quote depth", () => {
  const src = "> ```\n> [x](a.md)\n```\n> [y](b.md)\n> ```\n\n[z](c.md)\n";
  assert.deepEqual(markdownLinks(src).map((l) => l.target), ["c.md"]);
});

test("front matter: an unterminated quoted value is an error and the key is not set", () => {
  const bad = parseFrontMatter('---\napplyTo: "**\n---\n');
  assert.ok(bad);
  assert.ok(bad.errors.some((e) => e.includes("unterminated")));
  assert.equal(bad.data.applyTo, undefined);
  const nested = parseFrontMatter("---\nmetadata:\n  owner: 'je\n---\n");
  assert.ok(nested);
  assert.ok(nested.errors.some((e) => e.includes("unterminated")));
  assert.equal(/** @type {any} */ (nested.data.metadata).owner, undefined);
  const good = parseFrontMatter('---\napplyTo: "**/*.ts"\n---\n');
  assert.ok(good);
  assert.equal(good.errors.length, 0);
  assert.equal(good.data.applyTo, "**/*.ts");
  const multi = parseFrontMatter('---\ndescription: "first\n  second"\n---\n');
  assert.ok(multi);
  assert.equal(multi.errors.length, 0);
  assert.equal(multi.data.description, "first second");
});
