// @ts-check
/** @type {import("../types.mjs").Rule} */
export default {
  id: "canonical/detect",
  severity: "error",
  since: "0.1.0",
  docs: [
    "https://developers.openai.com/codex/guides/agents-md",
    "https://code.claude.com/docs/en/memory",
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
  ],
  rationale: "Every tool reads one file natively (Codex: AGENTS.md; Claude Code: CLAUDE.md, or AGENTS.md when there is none; Copilot: AGENTS.md, CLAUDE.md or GEMINI.md). Without a canonical file the other checks have nothing to compare against, and the tools each load something different.",
  fix: "Create AGENTS.md at the repository root, or set \"canonical\" in good-agent.config.json to the file the other instruction files point at.",
  run(ctx) {
    const { canonical, reason } = ctx.canonical;
    if (canonical === null) {
      const n = ctx.repo.files.length;
      return [{
        file: ".",
        message: n === 0
          ? "No instruction file found (no AGENTS.md, CLAUDE.md or .github/copilot-instructions.md)."
          : `No canonical instruction file: ${n} instruction files found, none referenced by the others (${reason}).`,
        data: { files: ctx.repo.files.map((f) => f.path) },
      }];
    }
    if (reason === "configured but missing") {
      return [{ file: canonical, message: `The configured canonical file ${canonical} does not exist or cannot be read as a regular file.`, fix: "Create it, make it readable, or fix \"canonical\" in good-agent.config.json." }];
    }
    return [];
  },
};
