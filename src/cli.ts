#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScan, DOCROT_VERSION, ScanError } from "./scanner.js";
import { initConfig, ConfigError, CONFIG_FILE_NAME } from "./config.js";
import { formatTerminalReport } from "./reporters/terminal.js";
import { formatJsonReport } from "./reporters/json.js";
import { colors } from "./utils/color.js";

export interface CliOptions {
  json?: boolean;
  changed?: boolean;
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("docrot")
    .description("Detect outdated, broken, or inconsistent documentation in software repositories.")
    .version(DOCROT_VERSION, "-v, --version", "Output the current version of docrot");

  // `docrot check [directory]`
  program
    .command("check [directory]", { isDefault: true })
    .description("Scan documentation files for rot, broken links, missing scripts, and env vars")
    .option("--json", "Output results as machine-readable JSON")
    .option("--changed", "Only scan documentation files changed relative to Git HEAD")
    .action(async (directory: string | undefined, options: CliOptions) => {
      const targetDir = directory ? path.resolve(directory) : process.cwd();

      try {
        const result = await runScan({
          targetDir,
          changed: options.changed,
          json: options.json,
        });

        if (options.json) {
          process.stdout.write(formatJsonReport(result) + "\n");
        } else {
          process.stdout.write(formatTerminalReport(result) + "\n");
        }

        if (result.summary.errors > 0) {
          process.exitCode = 1;
        } else {
          process.exitCode = 0;
        }
      } catch (err: any) {
        if (err instanceof ConfigError) {
          if (options.json) {
            process.stderr.write(
              JSON.stringify({ error: err.message, type: "ConfigError" }, null, 2) + "\n"
            );
          } else {
            process.stderr.write(
              `${colors.red(colors.bold("Configuration Error:"))} ${err.message}\n`
            );
          }
          process.exitCode = 2;
        } else if (err instanceof ScanError) {
          if (options.json) {
            process.stderr.write(
              JSON.stringify({ error: err.message, type: "ScanError" }, null, 2) + "\n"
            );
          } else {
            process.stderr.write(`${colors.red(colors.bold("Scan Error:"))} ${err.message}\n`);
          }
          process.exitCode = 2;
        } else {
          if (options.json) {
            process.stderr.write(
              JSON.stringify({ error: err.message || String(err), type: "FatalError" }, null, 2) +
                "\n"
            );
          } else {
            process.stderr.write(`${colors.red(colors.bold("Fatal Error:"))} ${err.message || err}\n`);
          }
          process.exitCode = 2;
        }
      }
    });

  // `docrot init`
  program
    .command("init [directory]")
    .description(`Create a starter ${CONFIG_FILE_NAME} configuration file`)
    .action(async (directory: string | undefined) => {
      const targetDir = directory ? path.resolve(directory) : process.cwd();
      try {
        const res = await initConfig(targetDir);
        if (res.created) {
          process.stdout.write(
            colors.green(`✔ Created starter configuration at ${res.path}\n`)
          );
          process.exitCode = 0;
        } else {
          process.stdout.write(
            colors.yellow(`ℹ Configuration already exists at ${res.path} (not overwritten)\n`)
          );
          process.exitCode = 0;
        }
      } catch (err: any) {
        process.stderr.write(
          `${colors.red(colors.bold("Error initializing config:"))} ${err.message || err}\n`
        );
        process.exitCode = 2;
      }
    });

  return program;
}

export async function runCli(args: string[]): Promise<number> {
  const program = createCli();
  // Override exit handling to avoid commander calling process.exit directly during tests
  program.exitOverride();

  try {
    process.exitCode = undefined;
    await program.parseAsync(args);
    const code = process.exitCode;
    return typeof code === "number" ? code : typeof code === "string" ? parseInt(code, 10) : 0;
  } catch (err: any) {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      return 0;
    }
    // Commander argument errors (unknown option, missing required arg)
    process.stderr.write(`${colors.red(colors.bold("Argument Error:"))} ${err.message}\n`);
    process.exitCode = 2;
    return 2;
  }
}

// Direct execution check
const isDirectExecution = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const currentPath = fileURLToPath(import.meta.url);
    const invokedPath = path.resolve(process.argv[1]);
    return currentPath === invokedPath;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  runCli(process.argv).then((code) => {
    process.exit(code);
  });
}
