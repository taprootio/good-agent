// @ts-check
import { parseFrontMatter } from "../../markdown.mjs";

const EXCLUDE_AGENT = new Set(["code-review", "cloud-agent"]);

/** @type {import("../types.mjs").Rule} */
export default {
  id: "copilot/applyto",
  severity: "error",
  since: "0.1.0",
  docs: ["https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions"],
  rationale: "A path-specific instruction file (.github/instructions/NAME.instructions.md) is attached only to requests whose files match its applyTo glob, declared in a front matter block at the top of the file. Without applyTo, Copilot never attaches the file. excludeAgent, when present, must be code-review or cloud-agent.",
  fix: "Start the file with a front matter block:\n---\napplyTo: \"**/*.ts\"\n---",
  run(ctx) {
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    for (const f of ctx.repo.files) {
      if (!/^\.github\/instructions\/.+\.instructions\.md$/.test(f.path)) continue;
      const fm = parseFrontMatter(f.text);
      if (!fm) { out.push({ file: f.path, line: 1, message: "No front matter; Copilot never attaches this file to any request because it has no applyTo." }); continue; }
      const applyTo = fm.data.applyTo;
      if (typeof applyTo !== "string" || applyTo.trim() === "") { out.push({ file: f.path, line: 1, message: "Front matter has no applyTo; Copilot never attaches this file to any request." }); continue; }
      const ex = fm.data.excludeAgent;
      if (ex !== undefined && (typeof ex !== "string" || !EXCLUDE_AGENT.has(ex))) {
        out.push({ file: f.path, line: 1, message: `excludeAgent must be "code-review" or "cloud-agent", got ${JSON.stringify(ex)}.`, fix: "Use one of the two documented values, or remove excludeAgent so both surfaces use the file." });
      }
    }
    return out;
  },
};
