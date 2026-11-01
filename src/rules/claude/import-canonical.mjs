// @ts-check
import { posix } from "node:path";
import { referencesOf } from "../../discover.mjs";

/**
 * The import line (an at sign and a path) that reaches `canonical` from `fromPath`, relative to the
 * importing file as Claude resolves it, with spaces escaped.
 * @param {string} fromPath
 * @param {string} canonical
 */
export function importText(fromPath, canonical) {
  const rel = posix.relative(posix.dirname(fromPath), canonical) || canonical;
  return `@${rel.replace(/ /g, "\\ ")}`;
}

/** @type {import("../types.mjs").Rule} */
export default {
  id: "claude/import-canonical",
  severity: "error",
  since: "0.1.0",
  docs: ["https://code.claude.com/docs/en/memory"],
  rationale: "Claude Code loads another file at launch only through an @path import. A Markdown link or a sentence saying \"read AGENTS.md\" is followed only if Claude decides to open the file, so the canonical guidance is not reliably in context. When there is no CLAUDE.md at all, Claude Code 2.1.277 and later read AGENTS.md directly; older versions load nothing, and no version reads a canonical file with any other name on its own.",
  fix: "Make the first line of CLAUDE.md an import of the canonical file, for example @AGENTS.md, and keep Claude-only notes below it.",
  run(ctx) {
    const { canonical } = ctx.canonical;
    if (canonical === null || canonical === "CLAUDE.md" || canonical === ".claude/CLAUDE.md") return [];
    const claudeFiles = ctx.repo.files.filter((f) => f.path === "CLAUDE.md" || f.path === ".claude/CLAUDE.md");
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    if (claudeFiles.length === 0) {
      if (canonical === "AGENTS.md") {
        out.push({
          file: "AGENTS.md",
          message: "No CLAUDE.md. Claude Code 2.1.277 and later read AGENTS.md directly when no CLAUDE.md exists; older versions load nothing.",
          fix: "Optional: add a CLAUDE.md containing @AGENTS.md for older Claude Code versions and for Claude-only notes.",
          data: { severity: "info" },
        });
      } else {
        out.push({
          file: canonical,
          message: `No CLAUDE.md, and the canonical file is ${canonical}, which Claude Code never loads on its own.`,
          fix: `Add a CLAUDE.md whose first line is ${importText("CLAUDE.md", canonical)}.`,
        });
      }
      return out;
    }
    const canonFile = ctx.repo.byPath.get(canonical);
    for (const cf of claudeFiles) {
      // The documented symlink bridge (ln -s AGENTS.md CLAUDE.md) loads the
      // canonical file directly; nothing to import.
      if (cf.symlink && canonFile && cf.realPath === canonFile.realPath) continue;
      const refs = referencesOf(cf);
      if (refs.some((r) => r.kind === "import" && r.resolved === canonical)) continue;
      const linked = refs.some((r) => r.kind === "link" && r.resolved === canonical);
      const wrongImport = refs.find((r) => r.kind === "import" && posix.basename(r.target) === posix.basename(canonical));
      const mentioned = cf.text.includes(canonical);
      const how = linked
        ? `links to ${canonical} as a Markdown link, which Claude Code only follows if it decides to open the file`
        : wrongImport
          ? `imports @${wrongImport.target}, which resolves to ${wrongImport.resolved ?? "a path outside the repository"}, not to ${canonical}`
          : mentioned
            ? `mentions ${canonical} in prose but does not import it`
            : `does not reference ${canonical} at all`;
      out.push({
        file: cf.path,
        line: wrongImport ? wrongImport.line : 1,
        message: wrongImport ? `${cf.path} ${how}.` : `${cf.path} ${how}. Claude Code imports a file only through @path syntax.`,
        fix: wrongImport
          ? `Change the import to ${importText(cf.path, canonical)}; imports resolve relative to the importing file.`
          : `Replace the pointer with a line containing ${importText(cf.path, canonical)}; keep Claude-only notes below it.`,
      });
    }
    return out;
  },
};
