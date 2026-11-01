// @ts-check
import canonicalDetect from "./canonical/detect.mjs";
import canonicalName from "./canonical/name.mjs";
import codexSizeBudget from "./codex/size-budget.mjs";
import claudeImportCanonical from "./claude/import-canonical.mjs";
import claudeImportDepth from "./claude/import-depth.mjs";
import claudeSize from "./claude/size.mjs";
import linksBroken from "./links/broken.mjs";
import copilotApplyTo from "./copilot/applyto.mjs";
import dryCopiedCanonical from "./dry/copied-canonical.mjs";

/** @type {import("./types.mjs").Rule[]} */
export const RULES = [
  canonicalDetect,
  canonicalName,
  codexSizeBudget,
  claudeImportCanonical,
  claudeImportDepth,
  claudeSize,
  linksBroken,
  copilotApplyTo,
  dryCopiedCanonical,
];

export const RULE_IDS = RULES.map((r) => r.id);

/** @param {string} id */
export function ruleById(id) {
  return RULES.find((r) => r.id === id) ?? null;
}
