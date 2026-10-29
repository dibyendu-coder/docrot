import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export interface WalkOptions {
  ignore?: string[];
  extensions?: string[];
}

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".svn",
  ".hg",
]);

/**
 * Check if a path exists and return stats, or null if it doesn't.
 */
export async function statSafe(filePath: string): Promise<fsSync.Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Check if a file or directory exists synchronously.
 */
export function existsSync(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode a file buffer into a clean string, handling UTF-8, UTF-16LE (PowerShell default),
 * UTF-16BE, and stripping BOM markers.
 */
export function decodeBufferToString(buf: Buffer): string {
  if (buf.length === 0) return "";

  // UTF-8 with BOM: EF BB BF
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf-8");
  }

  // UTF-16 LE with BOM: FF FE (standard Windows PowerShell redirection output)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }

  // UTF-16 BE with BOM: FE FF
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1] ?? 0;
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }

  // Heuristic for UTF-16 LE without BOM (e.g. ASCII characters interleaved with 0x00)
  if (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00) {
    return buf.toString("utf16le");
  }

  // Default to UTF-8 and strip any leading zero-width no-break space (\uFEFF)
  const str = buf.toString("utf-8");
  return str.startsWith("\uFEFF") ? str.slice(1) : str;
}

/**
 * Read file content safely, auto-detecting encoding (UTF-8, UTF-16 LE/BE, BOM).
 */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    return decodeBufferToString(buf);
  } catch {
    return null;
  }
}

/**
 * Recursively find all markdown files under a directory.
 * Prevents following symlink loops by tracking realpaths.
 * Respects default ignored directories and custom ignore patterns.
 */
export async function findMarkdownFiles(
  rootDir: string,
  customIgnore: string[] = []
): Promise<string[]> {
  const results: string[] = [];
  const visitedRealPaths = new Set<string>();

  const ignorePatterns = customIgnore.map((p) => normalizePath(p));

  function isIgnored(relativeFilePath: string, isDirectory: boolean): boolean {
    const normalized = normalizePath(relativeFilePath);
    for (const pattern of ignorePatterns) {
      if (pattern === normalized) return true;
      if (isDirectory && normalized.startsWith(pattern.replace(/\/$/, "") + "/")) return true;
      if (normalized.startsWith(pattern + "/")) return true;
      // Simple glob wildcard matching like "docs/legacy/**"
      if (pattern.includes("*")) {
        const regexStr = "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$";
        const regex = new RegExp(regexStr);
        if (regex.test(normalized)) return true;
      }
    }
    return false;
  }

  async function walk(currentDir: string): Promise<void> {
    let realCurrent: string;
    try {
      realCurrent = await fs.realpath(currentDir);
    } catch {
      return;
    }

    if (visitedRealPaths.has(realCurrent)) {
      return; // Symlink loop detected, abort this branch
    }
    visitedRealPaths.add(realCurrent);

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // Inaccessible directory
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (isIgnored(relativePath, true)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isSymbolicLink()) {
        const stats = await statSafe(fullPath);
        if (stats && stats.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
            continue;
          }
          if (isIgnored(relativePath, true)) {
            continue;
          }
          await walk(fullPath);
        } else if (stats && stats.isFile()) {
          if (isMarkdownFile(entry.name) && !isIgnored(relativePath, false)) {
            results.push(path.resolve(fullPath));
          }
        }
      } else if (entry.isFile()) {
        if (isMarkdownFile(entry.name) && !isIgnored(relativePath, false)) {
          results.push(path.resolve(fullPath));
        }
      }
    }
  }

  await walk(rootDir);
  return results.sort();
}

export function isMarkdownFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === ".md" || ext === ".markdown" || ext === ".mdx";
}

/**
 * Standardize path to use forward slashes for cross-platform comparisons.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
