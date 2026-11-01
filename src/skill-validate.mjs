// @ts-check
/**
 * Validate a SKILL.md against the Agent Skills specification's front-matter
 * rules (https://agentskills.io/specification): `---` on line 1, name and
 * description required, name 1 to 64 lowercase letters, digits and hyphens
 * with no leading, trailing or doubled hyphen and equal to the directory
 * name, description up to 1024 characters, only the spec's keys.
 */
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseFrontMatter, countLines } from "./markdown.mjs";

export const SPEC_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/**
 * @param {string} skillPath  path to a SKILL.md
 * @param {{ maxLines?: number }} [options]
 * @returns {string[]}  problems; empty when valid
 */
export function validateSkillFile(skillPath, options = {}) {
  const text = readFileSync(skillPath, "utf8");
  return validateSkillText(text, basename(dirname(skillPath)), options);
}

/**
 * @param {string} text
 * @param {string} dirName
 * @param {{ maxLines?: number }} [options]
 * @returns {string[]}
 */
export function validateSkillText(text, dirName, options = {}) {
  /** @type {string[]} */
  const problems = [];
  const fm = parseFrontMatter(text);
  if (!fm) { problems.push("front matter must start on line 1 with ---"); return problems; }
  problems.push(...fm.errors);
  for (const key of Object.keys(fm.data)) if (!SPEC_KEYS.has(key)) problems.push(`unknown front matter key "${key}" (the spec allows ${[...SPEC_KEYS].join(", ")})`);
  const name = fm.data.name;
  if (typeof name !== "string" || name === "") problems.push("name is required");
  else {
    if (name.length > 64) problems.push("name is longer than 64 characters");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) problems.push("name must be lowercase letters, digits and hyphens, with no leading, trailing or doubled hyphen");
    if (name !== dirName) problems.push(`name "${name}" must match the directory name "${dirName}"`);
  }
  const description = fm.data.description;
  if (typeof description !== "string" || description.trim() === "") problems.push("description is required");
  else if (description.length > 1024) problems.push("description is longer than 1024 characters");
  const compatibility = fm.data.compatibility;
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) problems.push("compatibility must be a string of at most 500 characters");
  if (fm.data.metadata !== undefined && typeof fm.data.metadata !== "object") problems.push("metadata must be a map of string keys to string values");
  if (options.maxLines && countLines(text) > options.maxLines) problems.push(`file has ${countLines(text)} lines; the limit is ${options.maxLines}`);
  return problems;
}
