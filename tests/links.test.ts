import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkLinks, isExternalOrSpecial, splitUrl } from "../src/checks/links.js";
import type { CheckContext } from "../src/types.js";

describe("Link Checker", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-links-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createContext(markdownFiles: string[]): CheckContext {
    return {
      rootDir: tempDir,
      markdownFiles,
      config: {
        ignore: [],
        rules: {},
      },
    };
  }

  describe("URL helper functions", () => {
    it("identifies external and special URLs", () => {
      expect(isExternalOrSpecial("https://github.com/foo/bar")).toBe(true);
      expect(isExternalOrSpecial("http://localhost:3000")).toBe(true);
      expect(isExternalOrSpecial("//cdn.example.com/lib.js")).toBe(true);
      expect(isExternalOrSpecial("mailto:dev@example.com")).toBe(true);
      expect(isExternalOrSpecial("tel:+123456789")).toBe(true);
      expect(isExternalOrSpecial("javascript:void(0)")).toBe(true);
      expect(isExternalOrSpecial("./docs/setup.md")).toBe(false);
      expect(isExternalOrSpecial("../README.md")).toBe(false);
      expect(isExternalOrSpecial("/guide.md")).toBe(false);
    });

    it("splits URLs into path, query, and fragment", () => {
      expect(splitUrl("docs/setup.md?v=2#step-1")).toEqual({
        rawPath: "docs/setup.md",
        query: "v=2",
        fragment: "step-1",
      });
      expect(splitUrl("#installation")).toEqual({
        rawPath: "",
        query: null,
        fragment: "installation",
      });
      expect(splitUrl("images/logo.png?raw=true")).toEqual({
        rawPath: "images/logo.png",
        query: "raw=true",
        fragment: null,
      });
    });
  });

  describe("Filesystem link checks", () => {
    it("reports broken relative links and passes valid relative links", async () => {
      const readmePath = path.join(tempDir, "README.md");
      const docsDir = path.join(tempDir, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      const setupPath = path.join(docsDir, "setup.md");

      await fs.writeFile(setupPath, "# Setup\nAll good.");
      await fs.writeFile(
        readmePath,
        `# Welcome\n\n[Valid Setup](./docs/setup.md)\n[Broken Target](./docs/nonexistent.md)`
      );

      const context = createContext([readmePath, setupPath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("link/missing-target");
      expect(findings[0].message).toContain("Link target does not exist: ./docs/nonexistent.md");
      expect(findings[0].line).toBe(4);
    });

    it("handles nested directories and relative parent paths", async () => {
      const docsDir = path.join(tempDir, "docs", "guides");
      await fs.mkdir(docsDir, { recursive: true });
      const guidePath = path.join(docsDir, "guide.md");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(readmePath, "# Top Readme");
      await fs.writeFile(
        guidePath,
        `# Guide\n\n[Back to root](../../README.md)\n[Broken parent](../../MISSING.md)`
      );

      const context = createContext([guidePath, readmePath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("link/missing-target");
      expect(findings[0].message).toContain("Link target does not exist: ../../MISSING.md");
    });

    it("handles paths with spaces and URL encoding (%20)", async () => {
      const assetsDir = path.join(tempDir, "my assets");
      await fs.mkdir(assetsDir, { recursive: true });
      const imgPath = path.join(assetsDir, "my screenshot.png");
      await fs.writeFile(imgPath, "fake-image-bytes");

      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(
        readmePath,
        `# Images\n\n![Screenshot Encoded](./my%20assets/my%20screenshot.png)\n![Screenshot Spaces](./my assets/my screenshot.png)\n![Missing](./my%20assets/missing%20file.png)`
      );

      const context = createContext([readmePath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("link/missing-target");
      expect(findings[0].message).toContain("Image file does not exist: ./my assets/missing file.png");
    });

    it("validates heading fragments in the same file and target files", async () => {
      const readmePath = path.join(tempDir, "README.md");
      const subPath = path.join(tempDir, "docs.md");

      await fs.writeFile(
        subPath,
        `# API Reference\n\n## Getting Started\n\n### Sub-Section`
      );
      await fs.writeFile(
        readmePath,
        `# Overview\n\n## Quick Start\n\n[Same valid](#quick-start)\n[Same invalid](#unknown-heading)\n[Target valid](./docs.md#getting-started)\n[Target invalid](./docs.md#not-there)`
      );

      const context = createContext([readmePath, subPath]);
      const findings = await checkLinks(context);

      const fragmentFindings = findings.filter((f) => f.ruleId === "link/invalid-fragment");
      expect(fragmentFindings).toHaveLength(2);
      expect(fragmentFindings[0].message).toContain("Heading anchor '#unknown-heading' does not exist");
      expect(fragmentFindings[1].message).toContain("Heading anchor '#not-there' does not exist");
    });

    it("accepts valid directory links and root-relative links", async () => {
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(
        readmePath,
        `# Project\n\n[Source code](./src)\n[Root relative](/src)\n[Root relative missing](/nonexistent-dir)`
      );

      const context = createContext([readmePath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("does not exist: /nonexistent-dir");
    });

    it("detects broken reference-style links", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(
        readmePath,
        `# Docs\n\n[Good link][valid-ref]\n[Broken link][missing-ref]\n\n[valid-ref]: ./README.md`
      );

      const context = createContext([readmePath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("link/broken-reference");
      expect(findings[0].message).toContain("definition not found: '[missing-ref]'");
    });

    it("regression: detects broken relative links in files encoded in UTF-16LE with BOM", async () => {
      const readmePath = path.join(tempDir, "README.md");
      const docsDir = path.join(tempDir, "docs");
      await fs.mkdir(docsDir, { recursive: true });

      // Emulate PowerShell output: echo "# Test" > README.md; echo "[Broken](docs/missing.md)" >> README.md
      const utf16leBuffer = Buffer.from(
        "\ufeff# Test\r\n[Broken](docs/missing.md)\r\n",
        "utf16le"
      );
      await fs.writeFile(readmePath, utf16leBuffer);

      const context = createContext([readmePath]);
      const findings = await checkLinks(context);

      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("link/missing-target");
      expect(findings[0].file).toBe("README.md");
      expect(findings[0].line).toBe(2);
      expect(findings[0].message).toContain("docs/missing.md");
    });
  });
});
