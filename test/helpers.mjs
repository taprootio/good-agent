// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

/**
 * Run git in a directory with a fixed identity, for the tests that need a work tree.
 * @param {string} root
 * @param {...string} args
 */
export function git(root, ...args) {
  return execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/**
 * Copy a fixture directory to a throwaway directory, optionally as a git work tree.
 * @param {string} fixture
 * @param {{ git?: boolean }} [options]
 */
export function copyFixture(fixture, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "good-agent-"));
  cpSync(fixture, root, { recursive: true });
  if (options.git) git(root, "init", "-q", "-b", "main");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
