// @ts-check
/** @type {import("../types.mjs").Rule} */
export default {
  id: "codex/size-budget",
  severity: "error",
  since: "0.1.0",
  docs: [
    "https://developers.openai.com/codex/guides/agents-md",
    "https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs",
  ],
  rationale: "Codex concatenates AGENTS.md files from the repository root down to its working directory and stops adding bytes at project_doc_max_bytes (32 KiB by default). The limit is one budget for the whole chain, not per file: the file that crosses it is cut mid-file and everything after it never reaches Codex. No warning is shown to the user.",
  fix: "Move long sections into docs/ and link them from AGENTS.md, or split guidance into nested AGENTS.md files closer to the code they govern. Raising project_doc_max_bytes is per-user config and does not fix the repository.",
  run(ctx) {
    const limit = ctx.config.limits.codexBytes;
    /** @type {import("../types.mjs").Finding[]} */
    const out = [];
    for (const chain of ctx.chains) {
      if (chain.bytes <= limit) continue;
      let remaining = limit;
      let cut = chain.entries[chain.entries.length - 1];
      for (const entry of chain.entries) {
        if (entry.bytes > remaining) { cut = entry; break; }
        remaining -= entry.bytes;
      }
      const file = ctx.repo.byPath.get(cut.file);
      const text = file ? file.text : "";
      const buf = Buffer.from(text);
      const before = buf.subarray(0, Math.max(0, remaining)).toString("utf8");
      const line = before.split("\n").length;
      const heading = (before.match(/^#{1,6} .*$/gm) || []).pop() ?? "(no heading)";
      const lost = Buffer.byteLength(text) - remaining;
      const chainText = chain.entries.map((e) => e.file).join(" → ");
      out.push({
        file: cut.file,
        line,
        message: `Codex loads at most ${limit.toLocaleString("en-US")} bytes of AGENTS.md content along the chain ${chainText} (${chain.bytes.toLocaleString("en-US")} bytes). It truncates ${cut.file} at byte ${remaining.toLocaleString("en-US")} (line ${line}, inside "${heading}"); the last ${lost.toLocaleString("en-US")} bytes never reach Codex.`,
        data: { bytes: chain.bytes, limit, chain: chain.entries.map((e) => e.file), truncatedAt: remaining, lostBytes: lost, dir: chain.dir },
      });
    }
    return out;
  },
};
