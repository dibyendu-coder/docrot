import path from "node:path";
import { readFileSafe, statSafe, normalizePath } from "../utils/fs.js";
import { parseMarkdown, type MarkdownPosition } from "../utils/markdown.js";
import type { Finding, CheckContext, MakefileInfo } from "../types.js";

export interface DetectedMakeCommand {
  target: string;
  rawCommand: string;
  position?: MarkdownPosition;
}

/**
 * Check whether a target matches declared targets (exact match or pattern rule like %.o or test-%).
 */
export function matchesMakefileTarget(target: string, availableTargets: Set<string>): boolean {
  if (availableTargets.has(target)) {
    return true;
  }

  // Check pattern rules (targets containing '%')
  for (const declared of availableTargets) {
    if (declared.includes("%")) {
      const escaped = declared
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, "(?:.+)");
      const regex = new RegExp(`^${escaped}$`);
      if (regex.test(target)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse declared targets from a Makefile content string.
 */
export function parseMakefileTargets(content: string): {
  targets: Set<string>;
  defaultTarget: string | null;
} {
  const targets = new Set<string>();
  let defaultTarget: string | null = null;

  // Handle line continuation: replace escaped newlines
  const unfolded = content.replace(/\\\r?\n/g, " ");
  const lines = unfolded.split(/\r?\n/);

  let inDefine = false;
  for (const line of lines) {
    // Recipe lines in Makefile start with a tab character: ignore them
    if (line.startsWith("\t")) {
      continue;
    }

    // Strip comments: unescaped # to end of line
    const lineWithoutComment = line.replace(/(?<!\\)#.*$/, "");
    const trimmed = lineWithoutComment.trim();
    if (!trimmed) {
      continue;
    }

    // Handle multiline define ... endef blocks
    if (trimmed.startsWith("define ") || trimmed === "define") {
      inDefine = true;
      continue;
    }
    if (inDefine) {
      if (trimmed === "endef") {
        inDefine = false;
      }
      continue;
    }

    // Support .DEFAULT_GOAL := target or .DEFAULT_GOAL = target
    const defaultGoalMatch = trimmed.match(/^\.DEFAULT_GOAL\s*[:?]?=\s*([A-Za-z0-9_./%-]+)/);
    if (defaultGoalMatch) {
      defaultTarget = defaultGoalMatch[1];
      continue;
    }

    // Skip assignments: VAR = val, VAR := val, VAR ?= val, VAR += val, VAR ::= val, VAR != val
    if (/^(?:export\s+|override\s+)?[A-Za-z0-9_.-]+\s*(?:::|[:?+!])?=\s*/.test(trimmed)) {
      continue;
    }

    // Match targets: "target1 target2: [prerequisites] [; command]"
    // Avoid double colon rule confusion and match standard rule definition
    const ruleMatch = trimmed.match(/^([A-Za-z0-9_./%-]+(?:\s+[A-Za-z0-9_./%-]+)*)\s*::?(?!=)\s*(.*)$/);
    if (ruleMatch) {
      const targetNames = ruleMatch[1].split(/\s+/).filter(Boolean);
      const prerequisites = ruleMatch[2] ? ruleMatch[2].split(/[;\s]+/).filter(Boolean) : [];

      for (const name of targetNames) {
        if (name === ".PHONY") {
          // Prerequisites of .PHONY are declared targets
          for (const prereq of prerequisites) {
            if (!prereq.startsWith("-") && !prereq.includes("=")) {
              targets.add(prereq);
            }
          }
        } else if (!name.startsWith(".")) {
          targets.add(name);
          if (!defaultTarget) {
            defaultTarget = name;
          }
        } else {
          // Other special dot-targets
          targets.add(name);
        }
      }
    }
  }

  return { targets, defaultTarget };
}

/**
 * Extract `make <target>` calls from code text.
 */
export function extractMakeInvocations(
  text: string,
  basePos?: MarkdownPosition
): DetectedMakeCommand[] {
  const commands: DetectedMakeCommand[] = [];

  // If text contains inline backticks (e.g. "Run `make` to build"), extract each snippet
  if (text.includes("`")) {
    const backtickRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickRegex.exec(text)) !== null) {
      const inner = match[1];
      const innerCommands = extractMakeInvocations(inner, basePos);
      commands.push(...innerCommands);
    }
    return commands;
  }

  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let cleaned = rawLine.trim();
    if (!cleaned.startsWith("$(") && !cleaned.startsWith("${")) {
      cleaned = cleaned.replace(/^[$#>%\s]+/, "").trim();
    } else {
      cleaned = cleaned.replace(/^[#>%\s]+/, "").trim();
    }
    const lineNum = basePos?.line !== undefined ? basePos.line + i : undefined;

    const subCommands = cleaned.split(/(?:&&|\|\||;|\|)/);

    for (const sub of subCommands) {
      const trimmed = sub.trim();
      if (!trimmed) continue;

      // Check if command starts with `make` or `$(MAKE)` or `${MAKE}` as an executable name
      // e.g. "make build", "make -j4 test", "$(MAKE) clean", "make"
      const makeRegex = /^(?:make|\$\(?MAKE\)?|\$\{MAKE\})(?:\s+(.*))?$/;
      const match = trimmed.match(makeRegex);
      if (!match) continue;

      const rest = match[1] ? match[1].trim() : "";
      if (!rest) {
        // Bare `make` -> targets the default target
        commands.push({
          target: "@default",
          rawCommand: trimmed,
          position: lineNum ? { line: lineNum } : basePos,
        });
        continue;
      }

      // Split arguments, skipping flags and variable overrides (VAR=val)
      const tokens = rest.split(/\s+/);
      const targetCandidates: string[] = [];
      let skipNext = false;

      for (let j = 0; j < tokens.length; j++) {
        if (skipNext) {
          skipNext = false;
          continue;
        }

        const token = tokens[j];

        // Options taking argument, e.g. -f Makefile, -C dir, -j 4
        if (["-f", "--file", "-C", "--directory", "-j", "--jobs", "-o", "-W"].includes(token)) {
          skipNext = true;
          continue;
        }

        // Flags starting with -
        if (token.startsWith("-")) {
          // If flag is e.g. -j4, it carries its own argument
          continue;
        }

        // Variable assignment like ENV=production or CC=gcc
        if (token.includes("=")) {
          continue;
        }

        // Ignore placeholder tokens such as <target>, [target]
        if (
          (token.startsWith("<") && token.endsWith(">")) ||
          (token.startsWith("[") && token.endsWith("]"))
        ) {
          continue;
        }

        targetCandidates.push(token);
      }

      if (targetCandidates.length === 0) {
        // Only flags, e.g. `make -j4`
        commands.push({
          target: "@default",
          rawCommand: trimmed,
          position: lineNum ? { line: lineNum } : basePos,
        });
      } else {
        for (const target of targetCandidates) {
          commands.push({
            target,
            rawCommand: trimmed,
            position: lineNum ? { line: lineNum } : basePos,
          });
        }
      }
    }
  }

  return commands;
}

/**
 * Locate and read Makefile in repository root. Also parses included makefiles.
 */
export async function loadMakefile(rootDir: string): Promise<MakefileInfo | null> {
  const possibleNames = ["GNUmakefile", "makefile", "Makefile"];
  for (const name of possibleNames) {
    const makefilePath = path.join(rootDir, name);
    const content = await readFileSafe(makefilePath);
    if (content !== null) {
      const { targets } = parseMakefileTargets(content);

      // Support include / -include directives within repository
      const includeRegex = /^(?:-?include)\s+(.+)$/gm;
      let incMatch: RegExpExecArray | null;
      while ((incMatch = includeRegex.exec(content)) !== null) {
        const incFiles = incMatch[1].trim().split(/\s+/);
        for (const incFile of incFiles) {
          const resolvedInc = path.resolve(rootDir, incFile);
          const normalizedRoot = normalizePath(path.resolve(rootDir));
          const normalizedInc = normalizePath(resolvedInc);
          if (normalizedInc.startsWith(normalizedRoot + "/") || normalizedInc === normalizedRoot) {
            const incContent = await readFileSafe(resolvedInc);
            if (incContent !== null) {
              const incParsed = parseMakefileTargets(incContent);
              for (const t of incParsed.targets) {
                targets.add(t);
              }
            }
          }
        }
      }

      return {
        path: makefilePath,
        targets: Array.from(targets),
      };
    }
  }
  return null;
}

export async function checkMakeTargets(context: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Skip gracefully if no Makefile exists
  if (!context.makefile) {
    return findings;
  }

  const configuredSeverity = context.config.rules["make/missing-target"] ?? "error";
  if (configuredSeverity === "off") {
    return findings;
  }

  const makefileContent = await readFileSafe(context.makefile.path);
  if (!makefileContent) return findings;

  const { targets, defaultTarget } = parseMakefileTargets(makefileContent);

  // Combine with targets already stored in context.makefile.targets (e.g. from includes)
  for (const t of context.makefile.targets) {
    targets.add(t);
  }

  for (const filePath of context.markdownFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;

    const parsed = parseMarkdown(content);
    const relFile = normalizePath(path.relative(context.rootDir, filePath));

    for (const code of parsed.codes) {
      if (!code.isInline && code.lang) {
        const lang = code.lang.toLowerCase();
        const isShellLike = [
          "bash",
          "sh",
          "shell",
          "zsh",
          "console",
          "terminal",
          "makefile",
          "make",
          "cmd",
          "bat",
          "powershell",
          "ps1",
        ].includes(lang);
        if (!isShellLike) continue;
      }

      const detected = extractMakeInvocations(code.value, code.position);

      for (const item of detected) {
        if (item.target === "@default") {
          if (!defaultTarget && targets.size === 0) {
            findings.push({
              ruleId: "make/missing-target",
              severity: configuredSeverity,
              file: relFile,
              line: item.position?.line,
              column: item.position?.column,
              message: "Default Make target does not exist: Makefile has no declared targets",
              suggestion: "Add a default target to Makefile or specify an explicit target.",
            });
          }
          continue;
        }

        if (!matchesMakefileTarget(item.target, targets)) {
          findings.push({
            ruleId: "make/missing-target",
            severity: configuredSeverity,
            file: relFile,
            line: item.position?.line,
            column: item.position?.column,
            message: `Make target does not exist: ${item.target}`,
            suggestion: `Add the "${item.target}" target to Makefile or update the documentation.`,
          });
        }
      }
    }
  }

  return findings;
}
