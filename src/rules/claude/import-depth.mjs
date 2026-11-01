// @ts-check
/** @type {import("../types.mjs").Rule} */
export default {
  id: "claude/import-depth",
  severity: "warn",
  since: "0.1.0",
  docs: ["https://code.claude.com/docs/en/memory"],
  rationale: "Imported files can import other files, but only to a maximum depth of four hops. An import past that depth is silently not loaded.",
  fix: "Flatten the chain: import the deep file from CLAUDE.md directly, or link it by path instead of importing it.",
  run(ctx) {
    return ctx.launch.tooDeep.map((d) => ({
      file: d.via,
      line: d.line,
      message: `@${d.file} is imported from ${d.via} at hop five or deeper; Claude Code stops following imports after four hops, so it never loads.`,
      data: { target: d.file },
    }));
  },
};
