#!/usr/bin/env node
// @ts-check
/**
 * Write the fix recipes into skill/good-agent/SKILL.md between the
 * <!-- BEGIN RECIPES --> and <!-- END RECIPES --> markers from the rule
 * modules' rationale and fix text, so the skill and `good-agent explain`
 * never disagree. `--check` exits 1 when the file would change (the drift
 * test runs it); no publish-time build step.
 *
 * Usage: node scripts/sync-skill.mjs [--check] [path/to/SKILL.md]
 * The optional path (default skill/good-agent/SKILL.md in this repository)
 * lets a test point the script at a temporary copy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "../src/rules/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argPath = process.argv.slice(2).find((a) => !a.startsWith("--"));
const SKILL = argPath ? resolve(argPath) : join(here, "..", "skill", "good-agent", "SKILL.md");
const BEGIN = "<!-- BEGIN RECIPES -->";
const END = "<!-- END RECIPES -->";
// Wide lines and no "Source:" line keep the generated block inside the skill's
// 200-line target; `good-agent explain <rule>` prints the sources.
const WIDTH = 100;

/** @param {string} text @param {number} width @param {string} indent */
function wrap(text, width, indent) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const w of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + w).length > width) { lines.push(indent + line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    lines.push(indent + line);
  }
  return lines.join("\n");
}

export function renderRecipes() {
  const out = [""];
  for (const rule of RULES) {
    out.push(`### \`${rule.id}\` (${rule.severity})`, "");
    out.push(wrap(rule.rationale, WIDTH, ""), "");
    const [first, ...rest] = rule.fix.split("\n");
    out.push(wrap(`Fix: ${first}`, WIDTH, ""));
    // Later lines of a multi-line fix are literal text (a front matter
    // example, say): fence them so `---` cannot become a setext heading.
    if (rest.length > 0) out.push("```", ...rest, "```");
    out.push("");
  }
  return out.join("\n");
}

const check = process.argv.includes("--check");
const current = readFileSync(SKILL, "utf8");
const start = current.indexOf(BEGIN);
const end = current.indexOf(END);
if (start < 0 || end < 0 || end < start) { console.error(`${SKILL}: recipe markers missing`); process.exit(2); }
const next = `${current.slice(0, start + BEGIN.length)}\n${renderRecipes()}${current.slice(end)}`;
if (next === current) { if (!check) console.log("recipes up to date"); process.exit(0); }
if (check) { console.error(`${SKILL}: recipes are out of date; run npm run sync-skill`); process.exit(1); }
writeFileSync(SKILL, next);
console.log(`wrote recipes for ${RULES.length} rules into ${SKILL}`);
