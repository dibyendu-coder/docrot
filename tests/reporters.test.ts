import { describe, it, expect } from "vitest";
import {
  formatJsonReport,
  parseJsonReport,
  filterFindingsBySeverity,
  filterFindingsByRule,
} from "../src/reporters/json.js";
import { formatTerminalReport } from "../src/reporters/terminal.js";
import type { ScanResult } from "../src/types.js";

describe("JSON & Terminal Reporters", () => {
  const sampleResult: ScanResult = {
    status: "error",
    passed: false,
    scannedFiles: ["README.md", "docs/setup.md"],
    findings: [
      {
        ruleId: "link/missing-target",
        severity: "error",
        file: "README.md",
        line: 10,
        column: 3,
        message: "Link target does not exist: ./missing.md",
        suggestion: "Create the file or fix the link.",
      },
      {
        ruleId: "env/missing-example",
        severity: "warning",
        file: "README.md",
        line: 25,
        message: "Environment variable 'API_SECRET' is documented but missing from .env.example",
        suggestion: "Add 'API_SECRET' to .env.example",
      },
      {
        ruleId: "link/invalid-fragment",
        severity: "info",
        file: "docs/setup.md",
        line: 5,
        message: "Heading anchor '#intro' not found",
      },
    ],
    summary: {
      errors: 1,
      warnings: 1,
      infos: 1,
      filesScanned: 2,
      passed: false,
      status: "error",
    },
    metadata: {
      targetDir: "/repo",
      timestamp: "2026-10-30T00:00:00.000Z",
      version: "0.1.0",
      durationMs: 42,
    },
  };

  describe("formatJsonReport", () => {
    it("formats ScanResult as pretty-printed JSON by default", () => {
      const output = formatJsonReport(sampleResult);
      expect(output).toContain('{\n  "status": "error"');
      expect(output).toContain('  "findings": [');
      const parsed = JSON.parse(output);
      expect(parsed.summary.errors).toBe(1);
      expect(parsed.findings).toHaveLength(3);
    });

    it("formats ScanResult as compact JSON when pretty is false", () => {
      const output = formatJsonReport(sampleResult, { pretty: false });
      expect(output).not.toContain("\n");
      const parsed = JSON.parse(output);
      expect(parsed.summary.errors).toBe(1);
    });

    it("supports custom indentation", () => {
      const output = formatJsonReport(sampleResult, { indent: 4 });
      expect(output).toContain('{\n    "status": "error"');
      expect(output).toContain('    "findings": [');
    });
  });

  describe("parseJsonReport", () => {
    it("parses valid JSON report strings back to ScanResult", () => {
      const jsonStr = formatJsonReport(sampleResult);
      const parsed = parseJsonReport(jsonStr);
      expect(parsed.findings).toHaveLength(3);
      expect(parsed.summary.errors).toBe(1);
      expect(parsed.metadata.version).toBe("0.1.0");
    });

    it("throws an error when JSON structure is invalid", () => {
      expect(() => parseJsonReport('{"invalid": true}')).toThrow(
        "Invalid docrot JSON report structure"
      );
      expect(() => parseJsonReport("not json")).toThrow();
    });
  });

  describe("JSON filter utilities", () => {
    it("filters findings by severity", () => {
      const errors = filterFindingsBySeverity(sampleResult, "error");
      expect(errors).toHaveLength(1);
      expect(errors[0].ruleId).toBe("link/missing-target");

      const warnings = filterFindingsBySeverity(sampleResult, "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].ruleId).toBe("env/missing-example");

      const infos = filterFindingsBySeverity(sampleResult, "info");
      expect(infos).toHaveLength(1);
      expect(infos[0].ruleId).toBe("link/invalid-fragment");
    });

    it("filters findings by rule ID", () => {
      const linkFindings = filterFindingsByRule(sampleResult, "link/missing-target");
      expect(linkFindings).toHaveLength(1);
      expect(linkFindings[0].file).toBe("README.md");

      const empty = filterFindingsByRule(sampleResult, "npm/missing-script");
      expect(empty).toHaveLength(0);
    });
  });

  describe("formatTerminalReport", () => {
    it("reports clean state when findings are empty", () => {
      const cleanResult: ScanResult = {
        status: "success",
        passed: true,
        scannedFiles: ["README.md", "docs/1.md", "docs/2.md", "docs/3.md", "docs/4.md"],
        findings: [],
        summary: { errors: 0, warnings: 0, infos: 0, filesScanned: 5, passed: true, status: "success" },
        metadata: {
          targetDir: "/repo",
          timestamp: "2026-10-30T00:00:00.000Z",
          version: "0.1.0",
          durationMs: 10,
        },
      };

      const output = formatTerminalReport(cleanResult);
      expect(output).toContain("No documentation rot detected (5 files scanned)");
      expect(output).toContain("Summary: 0 errors, 0 warnings");
    });

    it("reports formatted grouped findings with line numbers and suggestions", () => {
      const output = formatTerminalReport(sampleResult);
      expect(output).toContain("README.md");
      expect(output).toContain("docs/setup.md");
      expect(output).toContain("Line 10:3");
      expect(output).toContain("Line 25:");
      expect(output).toContain("Suggestion: Create the file or fix the link.");
      expect(output).toContain("Summary: 1 error, 1 warning");
    });
  });
});
