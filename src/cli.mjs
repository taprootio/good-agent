// @ts-check
/**
 * The good-agent command line. `main` never runs on import: the bin and the
 * alias bin both call it and set `process.exitCode` from what it resolves to.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  void argv;
  return 0;
}
