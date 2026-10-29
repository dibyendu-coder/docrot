import path from "node:path";
import { readFileSafe, normalizePath } from "../utils/fs.js";
import { parseMarkdown, type MarkdownPosition } from "../utils/markdown.js";
import type { Finding, CheckContext, EnvExampleInfo } from "../types.js";

// Common words in documentation that are uppercase but NOT environment variables
const COMMON_NON_ENV_WORDS = new Set([
  "README",
  "CHANGELOG",
  "LICENSE",
  "CONTRIBUTING",
  "TODO",
  "NOTE",
  "WARNING",
  "ERROR",
  "INFO",
  "TIP",
  "IMPORTANT",
  "CAUTION",
  "HTTP",
  "HTTPS",
  "HTML",
  "JSON",
  "XML",
  "REST",
  "SOAP",
  "API",
  "SDK",
  "CLI",
  "GUI",
  "IDE",
  "URL",
  "URI",
  "UUID",
  "ID",
  "OK",
  "KO",
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "MIT",
  "BSD",
  "GPL",
  "APACHE",
  "AWS",
  "GCP",
  "SQL",
  "CI",
  "CD",
  "UTF_8",
  "UTF8",
  "UTF16",
  "ASCII",
  "SSL",
  "TLS",
  "TCP",
  "UDP",
  "IP",
  "DNS",
  "VAR_NAME",
  "VARIABLE_NAME",
  "YOUR_KEY",
  "YOUR_SECRET_KEY",
  "KEY_NAME",
  "ENV_VAR",
  "EXAMPLE_VAR",
  "TRUE",
  "FALSE",
  "NULL",
  "UNDEFINED",
  "NAN",
  "INFINITY",
  "SHA256",
  "SHA512",
  "MD5",
  "BASE64",
  "JWT",
  "SQLITE",
  "POSTGRES",
  "MYSQL",
  "REDIS",
  "MONGODB",
  "DOCKER",
  "KUBERNETES",
  "LINUX",
  "MACOS",
  "WINDOWS",
  "NODE",
  "NPM",
  "PNPM",
  "YARN",
  "BUN",
]);

export interface DetectedEnvVar {
  name: string;
  source: "explicit-syntax" | "assignment" | "convention";
  position?: MarkdownPosition;
}

/**
 * Compute Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[i - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

/**
 * Parse `.env.example` content into a list of variable names.
 * Ignores comments and blank lines. Does not expose or store secret values.
 */
export function parseEnvExample(content: string): string[] {
  const vars: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match KEY=value or export KEY=value or KEY: value or bare KEY
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*[:=]|\s*$)/);
    if (match) {
      vars.push(match[1]);
    }
  }

  return vars;
}

/**
 * Find the closest matching variable name in .env.example if one is close enough to be a typo.
 */
export function findSpellingCandidate(target: string, available: string[]): string | null {
  let closest: string | null = null;
  let minDistance = Infinity;

  const targetLower = target.toLowerCase();
  const targetNoUnderscores = target.replace(/_/g, "").toLowerCase();

  // Strip common framework prefixes for comparison (e.g. VITE_, REACT_APP_, NEXT_PUBLIC_)
  const stripPrefix = (s: string) => s.replace(/^(?:VITE_|REACT_APP_|NEXT_PUBLIC_|PUBLIC_)/i, "");
  const targetStripped = stripPrefix(target).toLowerCase();

  for (const candidate of available) {
    if (candidate === target) continue;

    const candLower = candidate.toLowerCase();
    const candNoUnderscores = candidate.replace(/_/g, "").toLowerCase();
    const candStripped = stripPrefix(candidate).toLowerCase();

    // Direct case mismatch or underscore mismatch
    if (targetLower === candLower || targetNoUnderscores === candNoUnderscores) {
      return candidate;
    }

    // Framework prefix match e.g. VITE_API_URL vs API_URL
    if (targetStripped === candStripped && targetStripped.length >= 3) {
      return candidate;
    }

    const dist = levenshteinDistance(target, candidate);
    const maxAllowedDist = target.length >= 5 ? 2 : 1;
    if (dist <= maxAllowedDist && dist < minDistance) {
      minDistance = dist;
      closest = candidate;
    }
  }

  return closest;
}

/**
 * Extract documented environment variables from a Markdown string.
 */
export function extractDocEnvVars(
  text: string,
  basePos?: MarkdownPosition
): DetectedEnvVar[] {
  const results: DetectedEnvVar[] = [];
  const seen = new Set<string>();

  const addVar = (
    name: string,
    source: DetectedEnvVar["source"],
    pos?: MarkdownPosition
  ) => {
    // Basic hygiene checks
    if (!name || name.length < 2) return;
    if (COMMON_NON_ENV_WORDS.has(name)) return;
    if (seen.has(name)) return;

    seen.add(name);
    results.push({ name, source, position: pos });
  };

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = basePos?.line !== undefined ? basePos.line + i : undefined;
    const currentPos: MarkdownPosition | undefined = lineNum ? { line: lineNum } : basePos;

    // 1. Explicit JS/TS syntax: process.env.VAR, process .env.VAR, process.env?.VAR, process.env['VAR'],
    // and modern Vite/Astro: import.meta.env.VAR, import.meta.env?.VAR, import.meta.env['VAR']
    const processEnvRegex = /(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)(?:\??\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;
    let match: RegExpExecArray | null;
    while ((match = processEnvRegex.exec(line)) !== null) {
      const varName = match[1] || match[2];
      addVar(varName, "explicit-syntax", currentPos);
    }

    // Deno: Deno.env.get("VAR")
    const denoRegex = /\bDeno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g;
    while ((match = denoRegex.exec(line)) !== null) {
      addVar(match[1], "explicit-syntax", currentPos);
    }

    // Python / Ruby: os.environ["VAR"], os.getenv("VAR"), ENV["VAR"]
    const osRegex = /\b(?:os\.environ\[\s*['"]|os\.getenv\(\s*['"]|ENV\[\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((match = osRegex.exec(line)) !== null) {
      addVar(match[1], "explicit-syntax", currentPos);
    }

    // 2. Shell variable expansions: ${VAR} or ${VAR:-default} or $VAR
    const shellBraceRegex = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-+=?][^}]*)?\}/g;
    while ((match = shellBraceRegex.exec(line)) !== null) {
      addVar(match[1], "explicit-syntax", currentPos);
    }

    const shellBareRegex = /(?:\s|^|\b)\$([A-Za-z_][A-Za-z0-9_]{1,})\b/g;
    while ((match = shellBareRegex.exec(line)) !== null) {
      addVar(match[1], "explicit-syntax", currentPos);
    }

    // 3. Export: export VAR=... or export VAR
    const exportRegex = /\bexport\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^\s=]+)?\b/g;
    while ((match = exportRegex.exec(line)) !== null) {
      addVar(match[1], "assignment", currentPos);
    }

    // Assignment: VAR=... or env VAR=... or cross-env VAR=...
    const assignmentRegex = /(?:\b(?:env|cross-env)\s+)?\b([A-Z_][A-Z0-9_]*)=(?=[^\s=])/g;
    while ((match = assignmentRegex.exec(line)) !== null) {
      addVar(match[1], "assignment", currentPos);
    }

    // 4. Conventional uppercase names containing underscores, e.g. DATABASE_URL, API_KEY
    // Must contain at least one underscore to avoid bare words like README, HTTP, GET
    const conventionRegex = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;
    while ((match = conventionRegex.exec(line)) !== null) {
      const candidate = match[1];
      if (!COMMON_NON_ENV_WORDS.has(candidate)) {
        addVar(candidate, "convention", currentPos);
      }
    }
  }

  return results;
}

/**
 * Locate and read .env.example (or .env.sample, .env.template, .env.dist) in repository root.
 */
export async function loadEnvExample(rootDir: string): Promise<EnvExampleInfo | null> {
  const possibleNames = [".env.example", ".env.sample", ".env.template", ".env.dist"];
  for (const name of possibleNames) {
    const envExamplePath = path.join(rootDir, name);
    const content = await readFileSafe(envExamplePath);
    if (content !== null) {
      const variables = parseEnvExample(content);
      return {
        path: envExamplePath,
        variables,
      };
    }
  }
  return null;
}

export async function checkEnvVars(context: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Skip gracefully if no .env.example exists
  if (!context.envExample) {
    return findings;
  }

  const configuredSeverity = context.config.rules["env/missing-example"] ?? "warning";
  if (configuredSeverity === "off") {
    return findings;
  }

  const availableVars = context.envExample.variables;
  const availableSet = new Set(availableVars);

  for (const filePath of context.markdownFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;

    const parsed = parseMarkdown(content);
    const relFile = normalizePath(path.relative(context.rootDir, filePath));
    const seenFileVars = new Set<string>();

    const evaluateItem = (item: DetectedEnvVar) => {
      if (!availableSet.has(item.name)) {
        const findingKey = `${item.name}:${item.position?.line ?? 0}`;
        if (seenFileVars.has(findingKey)) return;
        seenFileVars.add(findingKey);

        const candidate = findSpellingCandidate(item.name, availableVars);
        const suggestion = candidate
          ? `Did you mean '${candidate}'? Add '${item.name}' to .env.example or fix the spelling.`
          : `Add '${item.name}' to .env.example or update the documentation.`;

        findings.push({
          ruleId: "env/missing-example",
          severity: configuredSeverity,
          file: relFile,
          line: item.position?.line,
          column: item.position?.column,
          message: `Environment variable '${item.name}' is documented but missing from .env.example`,
          suggestion,
        });
      }
    };

    // 1. Check code blocks and inline code
    for (const code of parsed.codes) {
      const detected = extractDocEnvVars(code.value, code.position);
      for (const item of detected) {
        evaluateItem(item);
      }
    }

    // 2. Also check document lines for prose/table documented env vars
    const contentLines = content.split(/\r?\n/);
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];
      // Only inspect lines if they contain env-like patterns
      if (
        line.includes("process.env") ||
        line.includes("import.meta.env") ||
        line.includes("${") ||
        line.includes("export ") ||
        line.includes("_")
      ) {
        const detected = extractDocEnvVars(line, { line: i + 1 });
        for (const item of detected) {
          evaluateItem(item);
        }
      }
    }
  }

  return findings;
}
