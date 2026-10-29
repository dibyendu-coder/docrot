import path from "node:path";
import { readFileSafe, statSafe, normalizePath } from "./utils/fs.js";
import fs from "node:fs/promises";
import type { DocrotConfig, ResolvedConfig, Severity } from "./types.js";

export const CONFIG_FILE_NAME = ".docrotrc.json";

export const DEFAULT_RULES: Record<string, Severity> = {
  "link/missing-target": "error",
  "link/invalid-fragment": "warning",
  "link/broken-reference": "error",
  "link/malformed-path": "error",
  "npm/missing-script": "error",
  "make/missing-target": "error",
  "env/missing-example": "warning",
};

export const STARTER_CONFIG: DocrotConfig = {
  ignore: [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "vendor",
  ],
  rules: {
    "link/missing-target": "error",
    "link/invalid-fragment": "warning",
    "link/broken-reference": "error",
    "link/malformed-path": "error",
    "npm/missing-script": "error",
    "make/missing-target": "error",
    "env/missing-example": "warning",
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validate and resolve DocrotConfig.
 */
export function validateAndResolveConfig(
  rawConfig: any,
  configPath = CONFIG_FILE_NAME
): ResolvedConfig {
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
    throw new ConfigError(
      `Configuration error in ${configPath}: Root configuration must be a JSON object.`
    );
  }

  const ignore: string[] = [];
  if (rawConfig.ignore !== undefined) {
    if (!Array.isArray(rawConfig.ignore)) {
      throw new ConfigError(
        `Configuration error in ${configPath}: "ignore" field must be an array of strings.`
      );
    }
    for (const item of rawConfig.ignore) {
      if (typeof item !== "string") {
        throw new ConfigError(
          `Configuration error in ${configPath}: All "ignore" patterns must be strings.`
        );
      }
      const normalized = normalizePath(item.trim());
      // Security: Prevent ignored paths from escaping repository root
      if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(item)) {
        throw new ConfigError(
          `Configuration error in ${configPath}: Ignore pattern "${item}" cannot escape repository root or be absolute.`
        );
      }
      if (normalized) {
        ignore.push(normalized);
      }
    }
  }

  const resolvedRules: Record<string, Severity | "off"> = { ...DEFAULT_RULES };

  if (rawConfig.rules !== undefined) {
    if (typeof rawConfig.rules !== "object" || rawConfig.rules === null || Array.isArray(rawConfig.rules)) {
      throw new ConfigError(
        `Configuration error in ${configPath}: "rules" field must be an object.`
      );
    }

    const validSeverities = new Set(["error", "warning", "info", "off"]);

    for (const [ruleId, val] of Object.entries(rawConfig.rules)) {
      if (typeof val === "boolean") {
        resolvedRules[ruleId] = val ? (DEFAULT_RULES[ruleId] || "error") : "off";
      } else if (typeof val === "string") {
        const lower = val.toLowerCase();
        if (!validSeverities.has(lower)) {
          throw new ConfigError(
            `Configuration error in ${configPath}: Invalid severity "${val}" for rule "${ruleId}". Must be one of: "error", "warning", "info", "off", or true/false.`
          );
        }
        resolvedRules[ruleId] = lower as Severity | "off";
      } else {
        throw new ConfigError(
          `Configuration error in ${configPath}: Rule "${ruleId}" setting must be a severity string ("error"|"warning"|"info"|"off") or a boolean.`
        );
      }
    }
  }

  return {
    ignore,
    rules: resolvedRules,
  };
}

/**
 * Load configuration from a directory, if present.
 */
export async function loadConfig(rootDir: string): Promise<ResolvedConfig> {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  const content = await readFileSafe(configPath);

  if (content === null) {
    return {
      ignore: [],
      rules: { ...DEFAULT_RULES },
    };
  }

  let rawConfig: any;
  try {
    rawConfig = JSON.parse(content);
  } catch (err: any) {
    throw new ConfigError(
      `Configuration error in ${CONFIG_FILE_NAME}: Invalid JSON syntax - ${err.message}`
    );
  }

  return validateAndResolveConfig(rawConfig, CONFIG_FILE_NAME);
}

/**
 * Create a starter .docrotrc.json configuration file.
 */
export async function initConfig(targetDir: string): Promise<{ created: boolean; path: string }> {
  const configPath = path.join(targetDir, CONFIG_FILE_NAME);
  const exists = (await statSafe(configPath)) !== null;

  if (exists) {
    return { created: false, path: configPath };
  }

  const jsonContent = JSON.stringify(STARTER_CONFIG, null, 2) + "\n";
  await fs.writeFile(configPath, jsonContent, "utf-8");
  return { created: true, path: configPath };
}
