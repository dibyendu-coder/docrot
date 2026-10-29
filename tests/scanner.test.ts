import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runScan } from "../src/scanner.js";
import { ConfigError } from "../src/config.js";

const execFileAsync = promisify(execFile);

describe("Scanner Edge Cases & Advanced Features", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-scanner-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("respects ignore patterns from configuration", async () => {
    const legacyDir = path.join(tempDir, "legacy");
    const activeDir = path.join(tempDir, "active");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.mkdir(activeDir, { recursive: true });

    // Legacy file has a broken link, but should be ignored
    await fs.writeFile(
      path.join(legacyDir, "old.md"),
      "# Old\n[Broken Link](./nonexistent.md)"
    );

    // Active file is clean
    await fs.writeFile(
      path.join(activeDir, "guide.md"),
      "# Guide\nClean file."
    );

    // Write .docrotrc.json ignoring legacy/**
    await fs.writeFile(
      path.join(tempDir, ".docrotrc.json"),
      JSON.stringify({
        ignore: ["legacy/**"],
      })
    );

    const result = await runScan({ targetDir: tempDir });
    expect(result.summary.filesScanned).toBe(1);
    expect(result.findings).toHaveLength(0);
    expect(result.summary.errors).toBe(0);
  });

  it("applies rule severity overrides from configuration", async () => {
    const readme = path.join(tempDir, "README.md");
    await fs.writeFile(
      readme,
      "# Title\n\n```bash\nnpm run nonexistent\n```"
    );

    // Add package.json
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: {} })
    );

    // Override severity of npm/missing-script to warning
    await fs.writeFile(
      path.join(tempDir, ".docrotrc.json"),
      JSON.stringify({
        rules: {
          "npm/missing-script": "warning",
        },
      })
    );

    const result = await runScan({ targetDir: tempDir });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("warning");
    expect(result.summary.errors).toBe(0);
    expect(result.summary.warnings).toBe(1);
  });

  it("disables rules when configured as 'off' or false", async () => {
    const readme = path.join(tempDir, "README.md");
    await fs.writeFile(
      readme,
      "# Title\n\n```bash\nnpm run nonexistent\n```"
    );

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: {} })
    );

    await fs.writeFile(
      path.join(tempDir, ".docrotrc.json"),
      JSON.stringify({
        rules: {
          "npm/missing-script": "off",
        },
      })
    );

    const result = await runScan({ targetDir: tempDir });
    expect(result.findings).toHaveLength(0);
    expect(result.summary.errors).toBe(0);
  });

  it("prevents ignore patterns from escaping repository root", async () => {
    await fs.writeFile(
      path.join(tempDir, ".docrotrc.json"),
      JSON.stringify({
        ignore: ["../outside-repo"],
      })
    );

    await expect(runScan({ targetDir: tempDir })).rejects.toThrow(ConfigError);
  });

  it("prevents symlink loops from causing infinite recursion", async () => {
    const dirA = path.join(tempDir, "dirA");
    const dirB = path.join(dirA, "dirB");
    await fs.mkdir(dirB, { recursive: true });

    await fs.writeFile(path.join(dirA, "doc.md"), "# Document A");

    try {
      // Create symlink dirB/loop -> dirA
      await fs.symlink(dirA, path.join(dirB, "loop"), "junction");
    } catch {
      // On some Windows environments creating symlinks requires admin privileges; skip if not permitted
      return;
    }

    const result = await runScan({ targetDir: tempDir });
    expect(result.summary.filesScanned).toBeGreaterThanOrEqual(1);
  });

  it("handles repository and paths containing spaces", async () => {
    const spaceDir = path.join(tempDir, "my project folder", "docs sub");
    await fs.mkdir(spaceDir, { recursive: true });

    const mdFile = path.join(spaceDir, "getting started.md");
    const targetFile = path.join(spaceDir, "install guide.md");

    await fs.writeFile(targetFile, "# Install Guide");
    await fs.writeFile(
      mdFile,
      `# Getting Started\n[Install](./install%20guide.md)\n[Install Direct](./install guide.md)`
    );

    const result = await runScan({ targetDir: tempDir });
    expect(result.findings).toHaveLength(0);
    expect(result.summary.errors).toBe(0);
  });

  it("scans only changed files relative to Git HEAD with --changed", async () => {
    // Initialize temporary git repo
    try {
      await execFileAsync("git", ["init"], { cwd: tempDir });
      await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: tempDir });
      await execFileAsync("git", ["config", "user.email", "tester@example.com"], { cwd: tempDir });
    } catch {
      // Git not available in this test environment
      return;
    }

    const fileA = path.join(tempDir, "fileA.md");
    const fileB = path.join(tempDir, "fileB.md");

    // Both files start clean
    await fs.writeFile(fileA, "# File A");
    await fs.writeFile(fileB, "# File B\n[Missing In B](./missingB.md)");

    await execFileAsync("git", ["add", "."], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempDir });

    // Modify only fileA to have a broken link
    await fs.writeFile(fileA, "# File A\n[Missing In A](./missingA.md)");

    // Run scan with changed: true
    const result = await runScan({ targetDir: tempDir, changed: true });

    // Only fileA was changed relative to HEAD, so only fileA should be scanned!
    expect(result.summary.filesScanned).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toContain("fileA.md");
  });

  it("Phase 2: supports scanning a single Markdown file directly as target", async () => {
    const singleDoc = path.join(tempDir, "standalone.md");
    await fs.writeFile(singleDoc, "# Standalone\n[Broken Link](./missing-target.md)");

    const result = await runScan({ targetDir: singleDoc });
    expect(result.summary.filesScanned).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("link/missing-target");
  });

  it("Phase 2: rejects scanning non-markdown files as target path", async () => {
    const jsonFile = path.join(tempDir, "package.json");
    await fs.writeFile(jsonFile, "{}");

    await expect(runScan({ targetDir: jsonFile })).rejects.toThrow("Specified path is not a directory");
  });

  it("never executes shell commands found in documentation", async () => {
    const markerFile = path.join(tempDir, "existing-marker.txt");
    const createdFile = path.join(tempDir, "should-not-exist.txt");
    const injectedFile = path.join(tempDir, "injected.txt");
    await fs.writeFile(markerFile, "initial content");

    const dangerousDoc = path.join(tempDir, "dangerous.md");
    await fs.writeFile(
      dangerousDoc,
      `# Commands
\`\`\`bash
rm -rf existing-marker.txt
touch should-not-exist.txt
echo "injected" > injected.txt
npm run remove-all
make wipe-everything
\`\`\`

Inline command: \`rm -rf existing-marker.txt\`
`
    );

    const result = await runScan({ targetDir: tempDir });

    // Verify existing file was not removed
    const markerStats = await fs.stat(markerFile).catch(() => null);
    expect(markerStats).not.toBeNull();

    // Verify files were not created
    const createdStats = await fs.stat(createdFile).catch(() => null);
    expect(createdStats).toBeNull();

    const injectedStats = await fs.stat(injectedFile).catch(() => null);
    expect(injectedStats).toBeNull();

    expect(result.summary.filesScanned).toBe(1);
  });
});
