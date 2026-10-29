import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCli } from "../src/cli.js";

describe("CLI Integration & Exit Codes", () => {
  let tempDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-cli-test-"));
    stdoutChunks = [];
    stderrChunks = [];

    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;

    process.stdout.write = ((chunk: any) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as any;

    process.stderr.write = ((chunk: any) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as any;
  });

  afterEach(async () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("exits with 0 when repository has clean documentation", async () => {
    const readme = path.join(tempDir, "README.md");
    await fs.writeFile(readme, "# Clean Docs\n\nAll is well.");

    const code = await runCli(["node", "docrot", "check", tempDir]);
    expect(code).toBe(0);
    const output = stdoutChunks.join("");
    expect(output).toContain("No documentation rot detected");
    expect(output).toContain("Summary: 0 errors, 0 warnings");
  });

  it("exits with 1 when repository has documentation errors", async () => {
    const readme = path.join(tempDir, "README.md");
    await fs.writeFile(
      readme,
      "# Broken Docs\n\n[Missing File](./missing.md)"
    );

    const code = await runCli(["node", "docrot", "check", tempDir]);
    expect(code).toBe(1);
    const output = stdoutChunks.join("");
    expect(output).toContain("Link target does not exist: ./missing.md");
    expect(output).toContain("Summary: 1 error, 0 warnings");
  });

  it("outputs valid JSON without terminal colors when --json is passed", async () => {
    const readme = path.join(tempDir, "README.md");
    await fs.writeFile(
      readme,
      "# Broken Docs\n\n[Missing File](./missing.md)"
    );

    const code = await runCli(["node", "docrot", "check", tempDir, "--json"]);
    expect(code).toBe(1);
    const output = stdoutChunks.join("");

    // Output must parse as JSON cleanly
    const json = JSON.parse(output);
    expect(json).toHaveProperty("findings");
    expect(json).toHaveProperty("summary");
    expect(json).toHaveProperty("metadata");
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].ruleId).toBe("link/missing-target");
    expect(json.summary.errors).toBe(1);
  });

  it("exits with 2 for inaccessible or non-existent directories", async () => {
    const missingPath = path.join(tempDir, "does-not-exist");
    const code = await runCli(["node", "docrot", "check", missingPath]);
    expect(code).toBe(2);
    const errorOutput = stderrChunks.join("");
    expect(errorOutput).toContain("Directory does not exist or is inaccessible");
  });

  it("exits with 2 for invalid configuration in .docrotrc.json", async () => {
    const configPath = path.join(tempDir, ".docrotrc.json");
    await fs.writeFile(configPath, "{ invalid json content");

    const code = await runCli(["node", "docrot", "check", tempDir]);
    expect(code).toBe(2);
    const errorOutput = stderrChunks.join("");
    expect(errorOutput).toContain("Configuration Error:");
  });

  it("exits with 2 for invalid rule severity in .docrotrc.json", async () => {
    const configPath = path.join(tempDir, ".docrotrc.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        rules: {
          "link/missing-target": "fatal-severity",
        },
      })
    );

    const code = await runCli(["node", "docrot", "check", tempDir]);
    expect(code).toBe(2);
    const errorOutput = stderrChunks.join("");
    expect(errorOutput).toContain("Invalid severity");
  });

  it("docrot init creates starter configuration and does not overwrite existing", async () => {
    const initCode = await runCli(["node", "docrot", "init", tempDir]);
    expect(initCode).toBe(0);
    expect(stdoutChunks.join("")).toContain("Created starter configuration");

    const configFile = path.join(tempDir, ".docrotrc.json");
    const content = await fs.readFile(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.rules).toBeDefined();

    // Run init a second time
    stdoutChunks = [];
    const secondCode = await runCli(["node", "docrot", "init", tempDir]);
    expect(secondCode).toBe(0);
    expect(stdoutChunks.join("")).toContain("already exists");
  });

  it("exits with 0 on --help", async () => {
    const code = await runCli(["node", "docrot", "--help"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("Detect outdated, broken, or inconsistent documentation");
  });

  it("exits with 0 on --version", async () => {
    const code = await runCli(["node", "docrot", "--version"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("0.1.0");
  });

  it("regression: detects broken relative links in test fixture, reports rule and line, and exits with 1", async () => {
    const fixtureDir = path.join(tempDir, "test-fixture");
    const docsDir = path.join(fixtureDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Emulate user's fixture
    const readmeContent = "# Test\n[Broken](docs/missing.md)\n";
    await fs.writeFile(path.join(fixtureDir, "README.md"), readmeContent);

    stdoutChunks = [];
    const code = await runCli(["node", "docrot", "check", fixtureDir, "--json"]);
    expect(code).toBe(1);

    const json = JSON.parse(stdoutChunks.join(""));
    expect(json.summary.errors).toBe(1);
    expect(json.findings).toHaveLength(1);

    const finding = json.findings[0];
    expect(finding.ruleId).toBe("link/missing-target");
    expect(finding.severity).toBe("error");
    expect(finding.file).toBe("README.md");
    expect(finding.line).toBe(2);
    expect(finding.message).toContain("Link target does not exist: docs/missing.md");
    expect(finding.suggestion).toBeDefined();

    // Now verify terminal output formatting as well
    stdoutChunks = [];
    const termCode = await runCli(["node", "docrot", "check", fixtureDir]);
    expect(termCode).toBe(1);
    const termOutput = stdoutChunks.join("");
    expect(termOutput).toContain("README.md");
    expect(termOutput).toContain("Line 2");
    expect(termOutput).toContain("Link target does not exist: docs/missing.md");
    expect(termOutput).toContain("Summary: 1 error, 0 warnings");
  });

  it("Phase 2: CLI supports scanning a single Markdown file directly", async () => {
    const singleMd = path.join(tempDir, "GUIDE.md");
    await fs.writeFile(singleMd, "# Guide\n[Bad link](./does-not-exist.md)");

    stdoutChunks = [];
    const code = await runCli(["node", "docrot", "check", singleMd, "--json"]);
    expect(code).toBe(1);

    const json = JSON.parse(stdoutChunks.join(""));
    expect(json.summary.filesScanned).toBe(1);
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].file).toContain("GUIDE.md");
  });

  it("Phase 2: CLI outputs structured JSON to stderr on fatal errors when --json is passed", async () => {
    stderrChunks = [];
    const missing = path.join(tempDir, "no-such-path");
    const code = await runCli(["node", "docrot", "check", missing, "--json"]);
    expect(code).toBe(2);

    const stderrStr = stderrChunks.join("");
    const errJson = JSON.parse(stderrStr);
    expect(errJson.type).toBe("ScanError");
    expect(errJson.error).toContain("Directory does not exist or is inaccessible");
  });

  it("Phase 2: docrot check --json outputs all required fields without ANSI codes or decorative logs", async () => {
    const readme = path.join(tempDir, "README.md");
    const guide = path.join(tempDir, "GUIDE.md");
    await fs.writeFile(readme, "# Readme\n[Broken Target](./missing.md)");
    await fs.writeFile(guide, "# Guide\nValid guide content.");

    stdoutChunks = [];
    stderrChunks = [];
    const code = await runCli(["node", "docrot", "check", tempDir, "--json"]);
    expect(code).toBe(1);

    const stdoutStr = stdoutChunks.join("");

    // 1. No ANSI escape sequences anywhere in stdout
    // ANSI escapes typically start with \u001b or \x1b
    const ansiRegex = /\u001b\[[0-9;]*m/;
    expect(ansiRegex.test(stdoutStr)).toBe(false);

    // 2. Pure JSON output without decorative header or banner logs
    expect(stdoutStr.trim().startsWith("{")).toBe(true);
    expect(stdoutStr.trim().endsWith("}")).toBe(true);

    // 3. Must parse cleanly
    const json = JSON.parse(stdoutStr);

    // 4. Verify scan metadata
    expect(json).toHaveProperty("metadata");
    expect(json.metadata).toHaveProperty("targetDir");
    expect(json.metadata).toHaveProperty("timestamp");
    expect(json.metadata).toHaveProperty("version");
    expect(json.metadata).toHaveProperty("durationMs");
    expect(typeof json.metadata.durationMs).toBe("number");

    // 5. Verify scanned files
    expect(json).toHaveProperty("scannedFiles");
    expect(Array.isArray(json.scannedFiles)).toBe(true);
    expect(json.scannedFiles.length).toBe(2);

    // 6. Verify findings
    expect(json).toHaveProperty("findings");
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].ruleId).toBe("link/missing-target");

    // 7. Verify error counts and warning counts
    expect(json).toHaveProperty("summary");
    expect(json.summary.errors).toBe(1);
    expect(json.summary.warnings).toBe(0);
    expect(json.summary.filesScanned).toBe(2);

    // 8. Verify completion status
    expect(json.status).toBe("error");
    expect(json.passed).toBe(false);
  });

  it("Phase 2: warnings alone must NOT return exit code 1 (must return 0)", async () => {
    const readme = path.join(tempDir, "README.md");
    // Invalid fragment anchor is a warning by default ("link/invalid-fragment": "warning")
    await fs.writeFile(readme, "# Heading\n[Invalid Anchor](#nonexistent-anchor)");

    stdoutChunks = [];
    const code = await runCli(["node", "docrot", "check", tempDir, "--json"]);
    // Warnings alone must return 0!
    expect(code).toBe(0);

    const json = JSON.parse(stdoutChunks.join(""));
    expect(json.summary.errors).toBe(0);
    expect(json.summary.warnings).toBe(1);
    expect(json.status).toBe("success");
    expect(json.passed).toBe(true);
  });

  it("Phase 2: exits with 2 for invalid arguments", async () => {
    stderrChunks = [];
    stdoutChunks = [];
    const code = await runCli(["node", "docrot", "check", "--invalid-unrecognized-flag", "--json"]);
    expect(code).toBe(2);

    const stderrStr = stderrChunks.join("");
    const errJson = JSON.parse(stderrStr);
    expect(errJson.type).toBe("ArgumentError");
    expect(errJson.error).toContain("unknown option");
  });
});
