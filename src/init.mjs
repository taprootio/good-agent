// @ts-check
import { UsageError } from "./cli.mjs";

/**
 * Placeholder until GA0002 ships `init --skill`.
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 * @returns {number}
 */
export function runInit(args, out, err) {
  void args; void out; void err;
  throw new UsageError("init is not available in this version");
}
