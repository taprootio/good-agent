// @ts-check
/** @type {import("../types.mjs").Rule} */
export default {
  id: "canonical/name",
  severity: "warn",
  since: "0.1.0",
  docs: [
    "https://developers.openai.com/codex/guides/agents-md",
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
    "https://code.claude.com/docs/en/memory",
  ],
  rationale: "Codex reads AGENTS.md (and AGENTS.override.md) and ignores every other name unless each user adds it to project_doc_fallback_filenames in their own ~/.codex/config.toml. Copilot reads AGENTS.md, CLAUDE.md or GEMINI.md. Claude Code reads AGENTS.md when there is no CLAUDE.md, or whatever CLAUDE.md imports. AGENTS.md is the only name all three reach.",
  fix: "Rename the canonical file to AGENTS.md and keep CLAUDE.md as a file whose first line is @AGENTS.md.",
  run(ctx) {
    const { canonical } = ctx.canonical;
    if (canonical === null || canonical === "AGENTS.md") return [];
    // Copilot reads a root CLAUDE.md or GEMINI.md too; Codex reads AGENTS.md only.
    const copilotReads = canonical === "CLAUDE.md" || canonical === "GEMINI.md";
    const who = copilotReads ? "Codex does" : "Codex and Copilot do";
    return [{
      file: canonical,
      message: `The canonical file is ${canonical}. ${who} not read that name natively, so ${copilotReads ? "it sees" : "they see"} only the written pointers to it.`,
      data: { inbound: ctx.canonical.inbound.get(canonical) ?? 0, unreadBy: copilotReads ? ["codex"] : ["codex", "copilot"] },
    }];
  },
};
