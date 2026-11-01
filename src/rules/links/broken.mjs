// @ts-check
import { referencesOf, existsInRepo, isIgnoredTarget } from "../../discover.mjs";

/** @type {import("../types.mjs").Rule} */
export default {
  id: "links/broken",
  severity: "error",
  since: "0.1.0",
  docs: ["https://code.claude.com/docs/en/memory", "https://code.visualstudio.com/docs/copilot/customization/custom-instructions"],
  rationale: "An instruction file that links to a document that no longer exists sends the AI tool to nothing, and an @import of a missing file makes Claude Code silently load nothing for it. Links resolve relative to the file that holds them (a leading / means the repository root); imports resolve relative to the importing file, as the Claude Code docs say.",
  fix: "Fix the path, or remove the link or import.",
  run(ctx) {
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    for (const f of ctx.repo.files) {
      const seen = new Set();
      for (const r of referencesOf(f)) {
        if (r.resolved === null || isIgnoredTarget(r.resolved, ctx.config)) continue;
        const key = `${r.kind}:${r.line}:${r.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (existsInRepo(ctx.repo, r.resolved)) continue;
        out.push(r.kind === "import"
          ? { file: f.path, line: r.line, message: `Import @${r.target} (line ${r.line}) does not exist; Claude Code silently loads nothing for it.`, fix: "Fix the path.", data: { target: r.target, kind: r.kind } }
          : { file: f.path, line: r.line, message: `Link target ${r.target} (line ${r.line}) does not exist.`, data: { target: r.target, kind: r.kind } });
      }
    }
    return out;
  },
};
