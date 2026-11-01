// @ts-check
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(REPO, "scripts", "good-agent.mjs");
export const FIXTURES = join(REPO, "test", "fixtures");

/**
 * Run the CLI as a child process.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 */
export function run(args, options = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: options.cwd ?? REPO, encoding: "utf8", env: { ...process.env, ...(options.env ?? {}) } });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Build a throwaway tree in the OS temp dir from a path-to-content map.
 * @param {Record<string, string>} files
 */
export function tempTree(files) {
  const root = mkdtempSync(join(tmpdir(), "good-agent-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
