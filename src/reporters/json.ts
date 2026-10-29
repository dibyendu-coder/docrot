import type { ScanResult, Finding, Severity } from "../types.js";

export interface JsonReportOptions {
  pretty?: boolean;
  indent?: number;
}

/**
 * Format ScanResult into a JSON string.
 */
export function formatJsonReport(result: ScanResult, options?: JsonReportOptions): string {
  const pretty = options?.pretty ?? true;
  const indent = options?.indent ?? (pretty ? 2 : 0);
  return pretty ? JSON.stringify(result, null, indent) : JSON.stringify(result);
}

/**
 * Parse and validate a JSON report string into a ScanResult object.
 */
export function parseJsonReport(jsonStr: string): ScanResult {
  const parsed = JSON.parse(jsonStr);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.findings) ||
    !parsed.summary ||
    !parsed.metadata
  ) {
    throw new Error("Invalid docrot JSON report structure");
  }
  return parsed as ScanResult;
}

/**
 * Filter findings in a ScanResult by severity.
 */
export function filterFindingsBySeverity(result: ScanResult, severity: Severity): Finding[] {
  return result.findings.filter((f) => f.severity === severity);
}

/**
 * Filter findings in a ScanResult by rule ID.
 */
export function filterFindingsByRule(result: ScanResult, ruleId: string): Finding[] {
  return result.findings.filter((f) => f.ruleId === ruleId);
}

