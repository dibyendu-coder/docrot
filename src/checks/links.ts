import path from "node:path";
import { statSafe, readFileSafe, normalizePath } from "../utils/fs.js";
import { parseMarkdown, type ParsedMarkdown, type MarkdownPosition } from "../utils/markdown.js";
import type { Finding, CheckContext, Severity } from "../types.js";

const EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
  "javascript:",
  "data:",
  "ftp:",
  "ftps:",
  "ssh:",
  "ws:",
  "wss:",
]);

/**
 * Check whether a URL is external or a non-filesystem protocol.
 */
export function isExternalOrSpecial(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return true;
  }
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (match) {
    const protocol = match[1].toLowerCase() + ":";
    if (EXTERNAL_PROTOCOLS.has(protocol)) {
      return true;
    }
  }
  return false;
}

/**
 * Separate URL into path, query, and fragment parts.
 */
export function splitUrl(url: string): {
  rawPath: string;
  query: string | null;
  fragment: string | null;
} {
  let working = url.trim();
  let fragment: string | null = null;
  let query: string | null = null;

  const hashIdx = working.indexOf("#");
  if (hashIdx !== -1) {
    fragment = working.slice(hashIdx + 1);
    working = working.slice(0, hashIdx);
  }

  const queryIdx = working.indexOf("?");
  if (queryIdx !== -1) {
    query = working.slice(queryIdx + 1);
    working = working.slice(0, queryIdx);
  }

  return {
    rawPath: working,
    query,
    fragment,
  };
}

export class LinkChecker {
  private markdownCache = new Map<string, ParsedMarkdown>();

  private async getParsedMarkdown(filePath: string): Promise<ParsedMarkdown | null> {
    const normalized = path.resolve(filePath);
    if (this.markdownCache.has(normalized)) {
      return this.markdownCache.get(normalized)!;
    }

    const content = await readFileSafe(normalized);
    if (content === null) {
      return null;
    }

    const parsed = parseMarkdown(content);
    this.markdownCache.set(normalized, parsed);
    return parsed;
  }

  public async checkFile(filePath: string, context: CheckContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const parsed = await this.getParsedMarkdown(filePath);
    if (!parsed) {
      return findings;
    }

    const relFile = normalizePath(path.relative(context.rootDir, filePath));
    const ruleSeverity = (ruleId: string, defaultSeverity: Severity = "error"): Severity | "off" => {
      const configured = context.config.rules[ruleId];
      if (configured !== undefined) {
        return configured;
      }
      return defaultSeverity;
    };

    // 1. Check broken reference-style links (references without definitions)
    const brokenRefSeverity = ruleSeverity("link/broken-reference", "error");
    if (brokenRefSeverity !== "off") {
      const reportedIdentifiers = new Set<string>();
      for (const ref of parsed.references) {
        if (!parsed.definitions.has(ref.identifier) && !reportedIdentifiers.has(ref.identifier)) {
          reportedIdentifiers.add(ref.identifier);
          findings.push({
            ruleId: "link/broken-reference",
            severity: brokenRefSeverity,
            file: relFile,
            line: ref.position?.line,
            column: ref.position?.column,
            message: `Reference-style link definition not found: '[${ref.identifier}]'`,
            suggestion: `Add the reference definition '[${ref.identifier}]: <target>' or replace with an inline link.`,
          });
        }
      }
    }

    // 2. Check each link and image
    for (const link of parsed.links) {
      const rawUrl = link.url.trim();
      if (!rawUrl) continue;

      if (isExternalOrSpecial(rawUrl)) {
        continue;
      }

      const { rawPath, fragment } = splitUrl(rawUrl);

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        const malformedSeverity = ruleSeverity("link/malformed-path", "error");
        if (malformedSeverity !== "off") {
          findings.push({
            ruleId: "link/malformed-path",
            severity: malformedSeverity,
            file: relFile,
            line: link.position?.line,
            column: link.position?.column,
            message: `Malformed link target path: '${rawUrl}'`,
            suggestion: "Check the path for invalid URI encoding or illegal characters.",
          });
        }
        continue;
      }

      // If target is just a fragment in the current document (e.g. "#installation")
      if (!decodedPath) {
        if (fragment) {
          const fragmentSeverity = ruleSeverity("link/invalid-fragment", "error");
          if (fragmentSeverity !== "off") {
            const normalizedFragment = decodeURIComponent(fragment).toLowerCase();
            if (!parsed.anchors.has(normalizedFragment)) {
              findings.push({
                ruleId: "link/invalid-fragment",
                severity: fragmentSeverity,
                file: relFile,
                line: link.position?.line,
                column: link.position?.column,
                message: `Heading anchor '#${fragment}' does not exist in '${relFile}'`,
                suggestion: `Verify the heading exists or update the anchor to match one of the document headings.`,
              });
            }
          }
        }
        continue;
      }

      // Resolve the target path on disk
      let resolvedTarget: string;
      if (decodedPath.startsWith("/")) {
        // Root-relative path (relative to project/repo root)
        resolvedTarget = path.resolve(context.rootDir, "." + decodedPath);
      } else {
        // Relative to the markdown file
        resolvedTarget = path.resolve(path.dirname(filePath), decodedPath);
      }

      const stats = await statSafe(resolvedTarget);
      const missingSeverity = ruleSeverity("link/missing-target", "error");

      if (!stats) {
        if (missingSeverity !== "off") {
          const itemType = link.kind === "image" ? "Image file" : "Link target";
          findings.push({
            ruleId: "link/missing-target",
            severity: missingSeverity,
            file: relFile,
            line: link.position?.line,
            column: link.position?.column,
            message: `${itemType} does not exist: ${decodedPath}`,
            suggestion: `Create the file or update the link to point to an existing target.`,
          });
        }
        continue;
      }

      // If target exists and has a fragment anchor, validate anchor in target markdown file
      if (fragment && stats.isFile()) {
        const ext = path.extname(resolvedTarget).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".mdx") {
          const fragmentSeverity = ruleSeverity("link/invalid-fragment", "error");
          if (fragmentSeverity !== "off") {
            const targetParsed = await this.getParsedMarkdown(resolvedTarget);
            if (targetParsed) {
              const normalizedFragment = decodeURIComponent(fragment).toLowerCase();
              if (!targetParsed.anchors.has(normalizedFragment)) {
                const targetRel = normalizePath(path.relative(context.rootDir, resolvedTarget));
                findings.push({
                  ruleId: "link/invalid-fragment",
                  severity: fragmentSeverity,
                  file: relFile,
                  line: link.position?.line,
                  column: link.position?.column,
                  message: `Heading anchor '#${fragment}' does not exist in '${targetRel}'`,
                  suggestion: `Verify the heading exists in '${targetRel}' or update the fragment link.`,
                });
              }
            }
          }
        }
      }
    }

    return findings;
  }
}

export async function checkLinks(context: CheckContext): Promise<Finding[]> {
  const checker = new LinkChecker();
  const allFindings: Finding[] = [];

  for (const file of context.markdownFiles) {
    const fileFindings = await checker.checkFile(file, context);
    allFindings.push(...fileFindings);
  }

  return allFindings;
}
