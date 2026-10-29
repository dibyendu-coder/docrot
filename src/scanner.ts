import path from "node:path";
import { statSafe, findMarkdownFiles, isMarkdownFile } from "./utils/fs.js";
import { getChangedMarkdownFiles, isGitRepository } from "./utils/git.js";
import { loadConfig, validateAndResolveConfig } from "./config.js";
import { loadPackageJson, checkScripts } from "./checks/scripts.js";
import { loadMakefile, checkMakeTargets } from "./checks/make-targets.js";
import { loadEnvExample, checkEnvVars } from "./checks/env-vars.js";
import { checkLinks } from "./checks/links.js";
import type {
  ScanOptions,
  ScanResult,
  Finding,
  CheckContext,
  ResolvedConfig,
} from "./types.js";

export const DOCROT_VERSION = "0.1.0";

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

/**
 * Sort findings deterministically for reproducible output.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    const lineA = a.line ?? 0;
    const lineB = b.line ?? 0;
    if (lineA !== lineB) {
      return lineA - lineB;
    }
    const colA = a.column ?? 0;
    const colB = b.column ?? 0;
    if (colA !== colB) {
      return colA - colB;
    }
    return a.ruleId.localeCompare(b.ruleId);
  });
}

/**
 * Core scanner entry point.
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const startTime = Date.now();
  const targetDir = path.resolve(options.targetDir || ".");

  // 1. Verify target path exists
  const stats = await statSafe(targetDir);
  if (!stats) {
    throw new ScanError(`Directory does not exist or is inaccessible: ${targetDir}`);
  }

  let rootDir = targetDir;
  let markdownFiles: string[] = [];
  const isSingleFile = stats.isFile();

  if (isSingleFile) {
    if (!isMarkdownFile(targetDir)) {
      throw new ScanError(`Specified path is not a directory: ${targetDir}`);
    }
    rootDir = path.dirname(targetDir);
    markdownFiles = [targetDir];
  } else if (!stats.isDirectory()) {
    throw new ScanError(`Specified path is not a directory: ${targetDir}`);
  }

  // 2. Load or resolve config
  let config: ResolvedConfig;
  if (options.config) {
    config = validateAndResolveConfig(options.config);
  } else {
    config = await loadConfig(rootDir);
  }

  // 3. Discover Markdown files
  if (!isSingleFile) {
    if (options.changed) {
      const isRepo = await isGitRepository(targetDir);
      if (!isRepo) {
        throw new ScanError(
          `--changed was specified, but "${targetDir}" is not inside a Git repository.`
        );
      }
      const changedFiles = await getChangedMarkdownFiles(targetDir);
      if (changedFiles === null) {
        throw new ScanError(
          `Failed to inspect Git status for changed files in "${targetDir}".`
        );
      }
      markdownFiles = changedFiles;
    } else {
      markdownFiles = await findMarkdownFiles(targetDir, config.ignore);
    }
  }

  // 4. Load repository metadata
  const [packageJson, makefile, envExample] = await Promise.all([
    loadPackageJson(rootDir),
    loadMakefile(rootDir),
    loadEnvExample(rootDir),
  ]);

  const context: CheckContext = {
    rootDir,
    markdownFiles,
    packageJson: packageJson ?? undefined,
    makefile: makefile ?? undefined,
    envExample: envExample ?? undefined,
    config,
  };

  // 5. Run all checks concurrently
  const [linkFindings, scriptFindings, makeFindings, envFindings] = await Promise.all([
    checkLinks(context),
    checkScripts(context),
    checkMakeTargets(context),
    checkEnvVars(context),
  ]);

  const allFindings = sortFindings([
    ...linkFindings,
    ...scriptFindings,
    ...makeFindings,
    ...envFindings,
  ]);

  // 6. Calculate summary
  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const f of allFindings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    else if (f.severity === "info") infos++;
  }

  const durationMs = Date.now() - startTime;

  return {
    findings: allFindings,
    summary: {
      errors,
      warnings,
      infos,
      filesScanned: markdownFiles.length,
    },
    metadata: {
      targetDir,
      timestamp: new Date().toISOString(),
      version: DOCROT_VERSION,
      durationMs,
    },
  };
}
