// @ts-check
/** @type {import("../types.mjs").Rule} */
export default {
  id: "claude/size",
  severity: "warn",
  since: "0.1.0",
  docs: ["https://code.claude.com/docs/en/memory", "https://code.claude.com/docs/en/costs"],
  rationale: "The Claude Code docs recommend keeping each CLAUDE.md file under 200 lines: longer files consume more context and reduce adherence. Imported files load together with the file that imports them, so they count the same way. Claude Code itself warns at startup when an instruction file is over the recommended length, and when files together pass an undocumented combined limit.",
  fix: "Move reference material into docs/ linked by path (not @-imported), or into skills and path-scoped .claude/rules that load on demand.",
  run(ctx) {
    const limit = ctx.config.limits.claudeLines;
    const { entries, lines, fallback } = ctx.launch;
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    const summary = entries.map((e) => `${e.file} ${e.lines}`).join(" + ");
    for (const e of entries) {
      if (e.lines <= limit) continue;
      const how = e.via ? `loaded at launch through the @import in ${e.via}` : fallback && e.file === "AGENTS.md" ? "loaded at launch as the AGENTS.md fallback (no CLAUDE.md)" : "loaded at launch";
      out.push({
        file: e.file,
        message: `${e.lines} lines, ${how}; the docs recommend under ${limit} lines per file because longer files reduce adherence. Launch set: ${summary} = ${lines} lines.`,
        data: { lines: e.lines, limit, via: e.via, launchLines: lines },
      });
    }
    if (out.length === 0 && entries.length > 1 && lines > limit) {
      out.push({
        file: entries[0].file,
        message: `No single file is over ${limit} lines, but Claude Code loads ${lines} lines at launch in all (${summary}); the docs say a combined warning exists but give no number.`,
        fix: "Consider moving reference material into docs/ linked by path, or into skills and path-scoped .claude/rules that load on demand.",
        data: { lines, limit, launch: entries.map((e) => e.file), severity: "info" },
      });
    }
    return out;
  },
};
