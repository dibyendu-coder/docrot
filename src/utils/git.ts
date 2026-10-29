import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { isMarkdownFile, normalizePath } from "./fs.js";

const execFileAsync = promisify(execFile);

/**
 * Check if the target directory is inside a Git repository.
 */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get changed markdown files relative to Git HEAD.
 * Returns null if the directory is not a Git repository or git is unavailable.
 */
export async function getChangedMarkdownFiles(dir: string): Promise<string[] | null> {
  try {
    const isRepo = await isGitRepository(dir);
    if (!isRepo) {
      return null;
    }

    // Determine the root of the git repository
    const { stdout: gitRootOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
    });
    const gitRoot = gitRootOut.trim();

    const changedRelFiles = new Set<string>();

    // 1. Check if HEAD exists
    let hasHead = true;
    try {
      await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir });
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      // Diff against HEAD for staged and unstaged tracked changes
      try {
        const { stdout: diffOut } = await execFileAsync(
          "git",
          ["diff", "--name-only", "HEAD"],
          { cwd: dir }
        );
        for (const line of diffOut.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) changedRelFiles.add(trimmed);
        }
      } catch {
        // Fallback to diff
      }
    }

    // 2. Untracked and staged new files from status
    try {
      const { stdout: statusOut } = await execFileAsync(
        "git",
        ["status", "--porcelain", "-uall"],
        { cwd: dir }
      );
      for (const line of statusOut.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // Format is XY <path> or XY -> <path>
        const statusPath = line.slice(3).trim();
        if (statusPath) {
          // If renamed: "old -> new"
          const parts = statusPath.split(" -> ");
          const actualPath = parts[parts.length - 1];
          changedRelFiles.add(actualPath);
        }
      }
    } catch {
      // Ignore status failure
    }

    // Filter to markdown files and resolve absolute paths
    const results: string[] = [];
    for (const rel of changedRelFiles) {
      const absPath = path.resolve(gitRoot, rel);
      if (isMarkdownFile(absPath)) {
        results.push(absPath);
      }
    }

    return results.sort();
  } catch {
    return null;
  }
}
