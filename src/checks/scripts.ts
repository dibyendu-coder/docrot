import path from "node:path";
import { statSafe, readFileSafe, normalizePath } from "../utils/fs.js";
import { parseMarkdown, type ExtractedCode, type MarkdownPosition } from "../utils/markdown.js";
import type { Finding, CheckContext, Severity, PackageJsonInfo } from "../types.js";

const BUILTIN_NPM_COMMANDS = new Set([
  "install",
  "i",
  "ci",
  "init",
  "publish",
  "pack",
  "update",
  "up",
  "outdated",
  "audit",
  "link",
  "unlink",
  "login",
  "logout",
  "whoami",
  "config",
  "set",
  "get",
  "cache",
  "version",
  "view",
  "info",
  "show",
  "help",
  "explain",
  "fund",
  "exec",
  "prefix",
  "root",
  "bin",
  "dedupe",
  "find-dupes",
  "prune",
  "doctor",
  "bugs",
  "docs",
  "repo",
  "ping",
  "team",
  "access",
  "profile",
  "token",
  "search",
  "add",
  "remove",
  "upgrade",
  "create",
  "dlx",
]);

export interface DetectedNpmScript {
  scriptName: string;
  rawCommand: string;
  isLifecycle: boolean;
  position?: MarkdownPosition;
}

/**
 * Clean command line by removing prompt characters ($, #, >, %)
 */
function cleanCommandLine(line: string): string {
  return line.trim().replace(/^[$#>%\s]+/, "").trim();
}

/**
 * Extract npm scripts invoked in a snippet of text (code block or inline code).
 */
export function extractNpmScriptInvocations(
  text: string,
  basePos?: MarkdownPosition
): DetectedNpmScript[] {
  const invocations: DetectedNpmScript[] = [];

  // If text contains inline backticks (e.g. "Run `npm test` before committing"), extract each snippet
  if (text.includes("`")) {
    const backtickRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickRegex.exec(text)) !== null) {
      const inner = match[1];
      const innerInvocations = extractNpmScriptInvocations(inner, basePos);
      invocations.push(...innerInvocations);
    }
    return invocations;
  }

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const cleaned = cleanCommandLine(rawLine);
    const lineNum = basePos?.line !== undefined ? basePos.line + i : undefined;

    // Split compound commands by &&, ||, ;, |
    const subCommands = cleaned.split(/(?:&&|\|\||;|\|)/);

    for (const subCmd of subCommands) {
      const trimmed = subCmd.trim();
      if (!trimmed) continue;

      // Match script runners: npm, pnpm, yarn, bun
      // Matches:
      // npm run <script> / pnpm run <script> / yarn run <script> / bun run <script>
      // npm run-script <script>
      // npm test / pnpm test / yarn test / bun test
      // npm start / pnpm start / yarn start / bun start
      // npm restart / npm stop
      const scriptRunMatch = trimmed.match(
        /\b(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+([a-zA-Z0-9_.:-]+)(?:\s+.*)?$/
      );
      if (scriptRunMatch) {
        const scriptName = scriptRunMatch[1];
        // Ignore placeholder tokens such as <script>, <script-name>, [script]
        if (
          (scriptName.startsWith("<") && scriptName.endsWith(">")) ||
          (scriptName.startsWith("[") && scriptName.endsWith("]"))
        ) {
          continue;
        }
        invocations.push({
          scriptName,
          rawCommand: trimmed,
          isLifecycle: false,
          position: lineNum ? { line: lineNum } : basePos,
        });
        continue;
      }

      // Match lifecycle commands: npm test, npm start, etc.
      const lifecycleMatch = trimmed.match(
        /\b(?:npm|pnpm|yarn|bun)\s+(test|t|tst|start|stop|restart)(?:\s+.*)?$/
      );
      if (lifecycleMatch) {
        let cmd = lifecycleMatch[1];
        if (cmd === "t" || cmd === "tst") {
          cmd = "test";
        }
        invocations.push({
          scriptName: cmd,
          rawCommand: trimmed,
          isLifecycle: true,
          position: lineNum ? { line: lineNum } : basePos,
        });
      }
    }
  }

  return invocations;
}

/**
 * Load package.json from repository if present.
 */
export async function loadPackageJson(rootDir: string): Promise<PackageJsonInfo | null> {
  const pkgPath = path.join(rootDir, "package.json");
  const content = await readFileSafe(pkgPath);
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    const scripts: Record<string, string> =
      parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
    return {
      path: pkgPath,
      scripts,
    };
  } catch {
    return null;
  }
}

export async function checkScripts(context: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Skip gracefully if no package.json exists in root
  if (!context.packageJson) {
    return findings;
  }

  const configuredSeverity = context.config.rules["npm/missing-script"] ?? "error";
  if (configuredSeverity === "off") {
    return findings;
  }

  const scripts = context.packageJson.scripts;
  const pkgDir = path.dirname(context.packageJson.path);
  const hasServerJs = (await statSafe(path.join(pkgDir, "server.js"))) !== null;

  for (const filePath of context.markdownFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;

    const parsed = parseMarkdown(content);
    const relFile = normalizePath(path.relative(context.rootDir, filePath));

    for (const code of parsed.codes) {
      // Only inspect shell, bash, sh, zsh, console, or unlabeled code blocks / inline code
      if (!code.isInline && code.lang) {
        const lang = code.lang.toLowerCase();
        const isShellLike = [
          "bash",
          "sh",
          "shell",
          "zsh",
          "console",
          "terminal",
          "cmd",
          "bat",
          "powershell",
        ].includes(lang);
        if (!isShellLike) {
          // If explicitly marked as python, json, ts, etc., skip inspecting for npm commands
          continue;
        }
      }

      const detected = extractNpmScriptInvocations(code.value, code.position);

      for (const item of detected) {
        const scriptExists = Object.prototype.hasOwnProperty.call(scripts, item.scriptName);

        // Lifecycle conventions
        if (!scriptExists) {
          // npm start falls back to `node server.js` if server.js exists
          if (item.scriptName === "start" && hasServerJs) {
            continue;
          }

          findings.push({
            ruleId: "npm/missing-script",
            severity: configuredSeverity,
            file: relFile,
            line: item.position?.line,
            column: item.position?.column,
            message: `npm script does not exist: ${item.scriptName}`,
            suggestion: `Add "${item.scriptName}" to package.json scripts or update the command in documentation.`,
          });
        }
      }
    }
  }

  return findings;
}
