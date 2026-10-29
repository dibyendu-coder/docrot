export type Severity = "error" | "warning" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
}

export interface DocrotConfig {
  ignore?: string[];
  rules?: Record<string, boolean | Severity>;
}

export interface ResolvedConfig {
  ignore: string[];
  rules: Record<string, Severity | "off">;
}

export interface ScanOptions {
  targetDir: string;
  changed?: boolean;
  config?: DocrotConfig;
  json?: boolean;
}

export interface ScanSummary {
  errors: number;
  warnings: number;
  infos: number;
  filesScanned: number;
  passed?: boolean;
  status?: "success" | "error" | "completed";
}

export interface ScanMetadata {
  targetDir: string;
  timestamp: string;
  version: string;
  durationMs: number;
}

export interface ScanResult {
  status: "success" | "error" | "completed";
  passed: boolean;
  scannedFiles: string[];
  findings: Finding[];
  summary: ScanSummary;
  metadata: ScanMetadata;
}

export interface PackageJsonInfo {
  path: string;
  scripts: Record<string, string>;
}

export interface MakefileInfo {
  path: string;
  targets: string[];
}

export interface EnvExampleInfo {
  path: string;
  variables: string[];
}

export interface CheckContext {
  rootDir: string;
  markdownFiles: string[];
  packageJson?: PackageJsonInfo;
  makefile?: MakefileInfo;
  envExample?: EnvExampleInfo;
  config: ResolvedConfig;
}
