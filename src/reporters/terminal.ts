import { colors } from "../utils/color.js";
import type { ScanResult, Finding } from "../types.js";

export function formatTerminalReport(result: ScanResult): string {
  const lines: string[] = [];

  lines.push(`${colors.bold("docrot")} — Documentation health check\n`);

  if (result.findings.length === 0) {
    const fileCount = result.summary.filesScanned;
    const fileWord = fileCount === 1 ? "file" : "files";
    lines.push(colors.green(`✔ No documentation rot detected (${fileCount} ${fileWord} scanned)\n`));
    lines.push("Summary: 0 errors, 0 warnings");
    return lines.join("\n");
  }

  // Group findings by file
  const grouped = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    const list = grouped.get(finding.file) || [];
    list.push(finding);
    grouped.set(finding.file, list);
  }

  for (const [file, findings] of grouped.entries()) {
    lines.push(colors.bold(file));

    for (const finding of findings) {
      const sevLabel =
        finding.severity === "error"
          ? colors.red(colors.bold("  ERROR  "))
          : finding.severity === "warning"
          ? colors.yellow(colors.bold("  WARN   "))
          : colors.cyan(colors.bold("  INFO   "));

      const location = finding.line
        ? finding.column
          ? `Line ${finding.line}:${finding.column}`
          : `Line ${finding.line}`
        : "General";

      lines.push(`${sevLabel}${colors.dim(location + ":")} ${finding.message}`);
      if (finding.suggestion) {
        lines.push(`         ${colors.dim("Suggestion:")} ${finding.suggestion}`);
      }
      lines.push("");
    }
  }

  const errCount = result.summary.errors;
  const warnCount = result.summary.warnings;
  const errWord = errCount === 1 ? "error" : "errors";
  const warnWord = warnCount === 1 ? "warning" : "warnings";

  const summaryText = `Summary: ${errCount} ${errWord}, ${warnCount} ${warnWord}`;
  const styledSummary = errCount > 0 ? colors.red(colors.bold(summaryText)) : colors.bold(summaryText);

  lines.push(styledSummary);

  return lines.join("\n");
}
