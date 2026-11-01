// @ts-check
/**
 * `good-agent.config.json`: load, validate, defaults (docs/design.md 4.6).
 * Everything is optional and the file is optional. A malformed file, an
 * unknown key, an unknown rule id or a bad value is a ConfigError, which the
 * CLI turns into exit 2.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

export const CONFIG_FILENAME = "good-agent.config.json";
export const SEVERITIES = /** @type {const} */ (["error", "warn", "info", "off"]);
export const REVIEWERS = /** @type {const} */ (["codex", "claude"]);

/** @typedef {typeof SEVERITIES[number]} Severity */
/** @typedef {typeof REVIEWERS[number]} Reviewer */

/**
 * @typedef {object} ReviewerConfig
 * @property {string | null} model
 * @property {string} effort
 */

/**
 * @typedef {object} Config
 * @property {number} version
 * @property {string | null} canonical
 * @property {string[]} ignore
 * @property {string[]} extraFiles
 * @property {{ codexBytes: number, claudeLines: number, pointerBytes: number }} limits
 * @property {Record<string, Severity>} rules
 * @property {{ externalReviewer: Record<string, Reviewer>, codex: ReviewerConfig, claude: ReviewerConfig }} review
 */

export class ConfigError extends Error {}

/** @returns {Config} */
export function defaultConfig() {
  return {
    version: 1,
    canonical: null,
    ignore: [],
    extraFiles: [],
    limits: { codexBytes: 32768, claudeLines: 200, pointerBytes: 2048 },
    rules: {},
    review: {
      externalReviewer: { claude: "codex", codex: "claude" },
      codex: { model: null, effort: "medium" },
      claude: { model: "sonnet", effort: "high" },
    },
  };
}

/**
 * @param {string} root
 * @param {{ explicitPath?: string, knownRuleIds: Iterable<string> }} options
 * @returns {{ config: Config, path: string | null }}
 */
export function loadConfig(root, options) {
  const path = options.explicitPath ? resolve(root, options.explicitPath) : join(root, CONFIG_FILENAME);
  if (!existsSync(path)) {
    if (options.explicitPath) throw new ConfigError(`config file not found: ${path}`);
    return { config: defaultConfig(), path: null };
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: not valid JSON (${/** @type {Error} */ (error).message})`);
  }
  return { config: validateConfig(raw, new Set(options.knownRuleIds), path), path };
}

/**
 * @param {unknown} raw
 * @param {Set<string>} knownRuleIds
 * @param {string} where
 * @returns {Config}
 */
export function validateConfig(raw, knownRuleIds, where = CONFIG_FILENAME) {
  const config = defaultConfig();
  if (!isObject(raw)) throw new ConfigError(`${where}: the config must be a JSON object`);
  const allowed = new Set(["$schema", "version", "canonical", "ignore", "extraFiles", "limits", "rules", "review"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ConfigError(`${where}: unknown key "${key}"`);
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== "string") throw new ConfigError(`${where}: "$schema" must be a string`);
  if (raw.version !== undefined) {
    if (raw.version !== 1) throw new ConfigError(`${where}: "version" must be 1 (got ${JSON.stringify(raw.version)}); this good-agent reads config version 1`);
  }
  if (raw.canonical !== undefined) {
    if (typeof raw.canonical !== "string" || raw.canonical === "") throw new ConfigError(`${where}: "canonical" must be a non-empty string`);
    const c = raw.canonical.replace(/\\/g, "/");
    if (c.startsWith("/") || /^[A-Za-z]:\//.test(c)) throw new ConfigError(`${where}: "canonical" must be a repository-relative path, not an absolute one`);
    config.canonical = posix.normalize(c).replace(/^\.\//, "");
    if (config.canonical.startsWith("../") || config.canonical === "." || config.canonical === "..") throw new ConfigError(`${where}: "canonical" must be a path inside the repository`);
  }
  for (const key of /** @type {const} */ (["ignore", "extraFiles"])) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) throw new ConfigError(`${where}: "${key}" must be an array of non-empty strings`);
    config[key] = value;
  }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits)) throw new ConfigError(`${where}: "limits" must be an object`);
    for (const key of Object.keys(raw.limits)) {
      if (!Object.hasOwn(config.limits, key)) throw new ConfigError(`${where}: unknown limit "${key}"`);
      const v = raw.limits[key];
      if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) throw new ConfigError(`${where}: limits.${key} must be a positive integer`);
      config.limits[/** @type {keyof Config["limits"]} */ (key)] = /** @type {number} */ (v);
    }
  }
  if (raw.rules !== undefined) {
    if (!isObject(raw.rules)) throw new ConfigError(`${where}: "rules" must be an object`);
    for (const [id, value] of Object.entries(raw.rules)) {
      if (!knownRuleIds.has(id)) throw new ConfigError(`${where}: unknown rule id "${id}" (run \`good-agent rules\` for the list)`);
      /** @type {unknown} */
      let severity = value;
      if (isObject(value)) {
        for (const k of Object.keys(value)) {
          if (k !== "severity") throw new ConfigError(`${where}: rules.${id}: only "severity" is allowed in the object form in this version (got "${k}")`);
        }
        severity = value.severity;
      }
      if (typeof severity !== "string" || !SEVERITIES.includes(/** @type {Severity} */ (severity))) {
        throw new ConfigError(`${where}: rules.${id} must be one of ${SEVERITIES.join(", ")}`);
      }
      config.rules[id] = /** @type {Severity} */ (severity);
    }
  }
  if (raw.review !== undefined) {
    if (!isObject(raw.review)) throw new ConfigError(`${where}: "review" must be an object`);
    for (const key of Object.keys(raw.review)) {
      if (!["externalReviewer", "codex", "claude"].includes(key)) throw new ConfigError(`${where}: unknown review key "${key}"`);
    }
    const ext = raw.review.externalReviewer;
    if (ext !== undefined) {
      if (!isObject(ext)) throw new ConfigError(`${where}: review.externalReviewer must be an object`);
      for (const [author, reviewer] of Object.entries(ext)) {
        if (!REVIEWERS.includes(/** @type {Reviewer} */ (author)) || !REVIEWERS.includes(/** @type {Reviewer} */ (reviewer))) {
          throw new ConfigError(`${where}: review.externalReviewer keys and values must be codex or claude`);
        }
        config.review.externalReviewer[author] = /** @type {Reviewer} */ (reviewer);
      }
    }
    for (const tool of REVIEWERS) {
      const value = raw.review[tool];
      if (value === undefined) continue;
      if (!isObject(value)) throw new ConfigError(`${where}: review.${tool} must be an object`);
      for (const [k, v] of Object.entries(value)) {
        if (k !== "model" && k !== "effort") throw new ConfigError(`${where}: unknown review.${tool} key "${k}"`);
        if (typeof v !== "string" || v === "") throw new ConfigError(`${where}: review.${tool}.${k} must be a non-empty string`);
        config.review[tool][k] = v;
      }
    }
  }
  return config;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A small glob-to-RegExp translator for `ignore` and `extraFiles`: `**`
 * matches any number of path segments, `*` anything but `/`, `?` one
 * character. Matched against repo-relative POSIX paths.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = "^";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 1;
        if (g[i + 1] === "/") { i += 1; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`);
}
