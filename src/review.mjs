// @ts-check
import { UsageError } from "./cli.mjs";

/**
 * Placeholder until GA0004 ships `review`.
 * @param {string[]} args
 * @param {(s: string) => void} out
 * @param {(s: string) => void} err
 * @returns {Promise<number>}
 */
export async function runReview(args, out, err) {
  void args; void out; void err;
  throw new UsageError("review is not available in this version");
}
