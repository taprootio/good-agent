// @ts-check
import { withoutGeneratedBlocks } from "../../markdown.mjs";
import { importText } from "../claude/import-canonical.mjs";

/** @param {string} src */
function substantiveLines(src) {
  return withoutGeneratedBlocks(src).split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 20 && !l.startsWith("#") && l !== "---");
}

/** @type {import("../types.mjs").Rule} */
export default {
  id: "dry/copied-canonical",
  severity: "error",
  since: "0.1.0",
  docs: ["https://code.claude.com/docs/en/memory", "https://developers.openai.com/codex/guides/agents-md"],
  rationale: "A tool file that copies the canonical file instead of importing or pointing to it is a second copy that drifts the moment either is edited. Claude Code can import the canonical file with @path; Copilot reads AGENTS.md natively; neither needs a copy.",
  fix: "Replace the copy with @<canonical> (Claude Code) or a short pointer (Copilot), and keep only tool-specific notes in the tool file.",
  run(ctx) {
    const { canonical } = ctx.canonical;
    if (canonical === null) return [];
    const canonFile = ctx.repo.byPath.get(canonical);
    if (!canonFile) return [];
    const canon = new Set(substantiveLines(canonFile.text));
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    for (const f of ctx.repo.files) {
      if (f.path === canonical || f.realPath === canonFile.realPath) continue;
      const mine = substantiveLines(f.text);
      if (mine.length < 5) continue;
      const shared = mine.filter((l) => canon.has(l)).length;
      if (shared / mine.length < 0.5) continue;
      out.push({
        file: f.path,
        message: `${shared} of ${mine.length} substantive lines are copied from ${canonical}.`,
        fix: `Replace the copy with ${importText(f.path, canonical)} (Claude Code) or a pointer (Copilot).`,
        data: { shared, total: mine.length, canonical },
      });
    }
    return out;
  },
};
