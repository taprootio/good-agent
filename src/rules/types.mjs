// @ts-check
/**
 * @typedef {object} Finding
 * @property {string} file
 * @property {number} [line]
 * @property {string} message
 * @property {string} [fix]  overrides the rule's generic fix for this finding
 * @property {Record<string, unknown>} [data]
 */

/**
 * @typedef {object} RuleContext
 * @property {import("../discover.mjs").Repo} repo
 * @property {import("../config.mjs").Config} config
 * @property {{ canonical: string | null, inbound: Map<string, number>, reason: string }} canonical
 * @property {import("../discover.mjs").CodexChain[]} chains
 * @property {ReturnType<typeof import("../discover.mjs").claudeLaunchSet>} launch
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {"error" | "warn" | "info"} severity
 * @property {string} since
 * @property {string[]} docs  primary page first
 * @property {string} rationale
 * @property {string} fix
 * @property {(ctx: RuleContext) => Finding[]} run
 */

export {};
