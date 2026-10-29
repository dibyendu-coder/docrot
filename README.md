# docrot

<p align="center">
  <strong>Documentation rots. docrot catches it.</strong><br />
  Find broken documentation before developers find it the hard way.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-blue.svg" alt="TypeScript" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/tested%20with-vitest-6e9f18.svg" alt="Vitest" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
</p>

---

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Terminal Demo](#terminal-demo)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Example Findings](#example-findings)
- [Exit Codes](#exit-codes)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Security](#security)
- [Contributing](#contributing)
- [License and Author](#license-and-author)

---

## The Problem

Developers trust documentation, guides, and README files. When documentation goes stale, developers and contributors lose time debugging problems caused by docs that no longer match reality:

- **Dead relative links & moved files**: Links like `[Architecture](./docs/architecture.md)` lead to a 404 after a folder reorganization.
- **Missing or renamed npm scripts**: A contributor runs an outdated command like `npm run <setup>`, but the script was renamed or removed in `package.json`.
- **Outdated Make targets**: A README instructs contributors to run `make <deploy-staging>`, but the target was removed from the `Makefile`.
- **Undocumented environment variables**: A developer spends hours troubleshooting a silent crash because an environment variable was referenced in setup docs but missing from `.env.example`.

Documentation rot is silent, frustrating, and preventable.

---

## The Solution

**docrot** is a fast, offline-first command-line developer tool that audits documentation against repository truth.

Instead of performing superficial text matching, docrot builds a structured Markdown Abstract Syntax Tree (AST) using Unified and `remark-parse`. It extracts documented commands, links, anchors, and variables, and cross-references them against actual filesystem state, `package.json` scripts, `Makefile` targets, and `.env.example` keys.

- **Offline-First**: Scans local files and repositories instantly without external network requests.
- **Safe by Design**: Statically parses commands—**never executes** shell code found in Markdown.
- **Secret-Preserving**: Only audits template files (`.env.example`); strictly ignores `.env` secret files.
- **Developer-Friendly**: Provides clear terminal reporting with line numbers and actionable suggestions, plus machine-readable `--json` output for CI pipelines.

---

## Terminal Demo

### Human-Readable Terminal Scan

```text
$ docrot check

docrot — Documentation health check

README.md
  ERROR  Line 42:1: Link target does not exist: ./docs/architecture.md
         Suggestion: Create the file or update the link to point to an existing target.

  ERROR  Line 68: npm script does not exist: test:watch
         Suggestion: Add "test:watch" to package.json scripts or update the command in documentation.

  ERROR  Line 94: Make target does not exist: deploy-staging
         Suggestion: Add the "deploy-staging" target to Makefile or update the documentation.

  WARN   Line 115: Heading anchor '#quick-start' does not exist in 'README.md'
         Suggestion: Verify the heading exists or update the anchor to match one of the document headings.

Summary: 3 errors, 1 warning
```

### Machine-Readable JSON Output

```json
$ docrot check --json
{
  "status": "error",
  "passed": false,
  "scannedFiles": [
    "README.md",
    "docs/setup.md"
  ],
  "findings": [
    {
      "ruleId": "link/missing-target",
      "severity": "error",
      "file": "README.md",
      "line": 42,
      "column": 1,
      "message": "Link target does not exist: ./docs/architecture.md",
      "suggestion": "Create the file or update the link to point to an existing target."
    }
  ],
  "summary": {
    "errors": 1,
    "warnings": 0,
    "infos": 0,
    "filesScanned": 2,
    "passed": false,
    "status": "error"
  },
  "metadata": {
    "targetDir": "/workspace/project",
    "timestamp": "2026-10-30T00:00:00.000Z",
    "version": "0.1.0",
    "durationMs": 28
  }
}
```

---

## Features

### 1. Markdown Links & Fragment Validation
- **Relative Links**: Verifies relative paths to files and directories on disk.
- **Heading Fragment Anchors**: Validates `#heading-anchor` references against heading slugs generated from the target Markdown file.
- **Explicit HTML Anchors**: Validates links targeting `<a id="...">` or `<a name="...">` elements.
- **Reference-Style Links**: Detects `[text][ref]` syntax where `[ref]: ...` was never defined.
- **URL Encoding & Spaces**: Correctly decodes URL-encoded paths (e.g. `%20`) and spaces.
- **Root-Relative Links**: Resolves `/docs/page.md` paths relative to repository root.
- **Local Asset Verification**: Validates image paths in `![alt](./assets/screenshot.png)` and `<img src="..." />`.
- **External Protocol Skipping**: Skips non-filesystem URLs (`http://`, `https://`, `mailto:`, `tel:`) during offline scans.

### 2. npm & Package Manager Script Validation
- **Supported Managers**: Validates commands invoked with `npm`, `pnpm`, `yarn`, and `bun`.
- **Command Syntax**: Detects `npm run <script>`, `pnpm run <script>`, `yarn run <script>`, `bun run <script>`.
- **Lifecycle Commands**: Validates lifecycle scripts (`npm test`, `npm start`) against `package.json` (as well as `stop` and `restart` lifecycle events).
- **Fallback Awareness**: Recognizes that `npm start` automatically falls back to `node server.js` when `server.js` exists.
- **Command Disambiguation**: Safely ignores standard package manager commands (`install`, `add`, `publish`, `audit`, `pack`).
- **Graceful Skip**: Skips script validation automatically if no `package.json` exists in the repository.

### 3. Make Target Validation
- **Makefile Parsing**: Audits documented `make <target>` calls against targets in `Makefile`, `makefile`, or `GNUmakefile`.
- **Macro Support**: Recognizes `$(MAKE)` macro command syntax.
- **Pattern Rules**: Supports pattern rules (e.g. `test-%:`, `%.o:`, `deploy-%:`) to prevent false positives for parameterized targets.
- **Prerequisites & Phonies**: Parses declared `.PHONY` prerequisites as valid targets.
- **Recipe Isolation**: Safely skips recipe lines beginning with a tab character (`\t`) so commands containing colons (e.g. `docker run -p 8080:80`) are not parsed as targets.
- **Default Targets**: Recognizes default target directives and bare `make` invocations.
- **Include Directives**: Recursively inspects included local Makefiles (`include` and `-include`).
- **Graceful Skip**: Skips Make validation automatically if no Makefile exists in the repository.

### 4. Environment Variable Auditing
- **Syntax Detection**:
  - JavaScript / TypeScript: `process.env.ENV_VAR`, `process.env['ENV_VAR']`, `process.env?.ENV_VAR`
  - Modern Frontend: `import.meta.env.ENV_VAR`, `import.meta.env['ENV_VAR']`
  - Shell Expansions: `${ENV_VAR}`, `${ENV_VAR:-default}`, `${ENV_VAR:=default}`
  - Commands & Exports: `export ENV_VAR=value`, `ENV_VAR=value`
  - Table & Prose Detection: Identifies uppercase variable patterns across Markdown tables and bullet points.
- **Comparison Against Template**: Compares variables against `.env.example` (or fallback templates `.env.sample`, `.env.template`, `.env.dist`).
- **Typo & Prefix Suggestions**: Uses Levenshtein distance and prefix matching to suggest corrections (e.g. suggesting `EXAMPLE_VAR` when a spelling mismatch is detected).
- **False-Positive Filtering**: Automatically ignores standard uppercase technical terms (`README`, `API`, `HTTP`, `JSON`, `MIT`, `GET`, `POST`, `TRUE`, `FALSE`, `NULL`).
- **Secret Isolation**: Never reads `.env` or `.env.local` files; never stores or prints secret values.

### 5. Fast Traversal & Git Awareness
- **Symlink Protection**: Tracks filesystem realpaths to detect and stop circular symlink loops.
- **Git Differential Scanning (`--changed`)**: Scans only documentation files modified relative to Git `HEAD`.
- **Single-File Mode**: Directly audits specific Markdown files (e.g. `docrot check README.md`).

---

## Installation

> **Note**: docrot is currently in active development and has not yet been published to the public npm registry. Follow the instructions below to install and run locally.

### Prerequisites

- [Node.js](https://nodejs.org/) `>= 20.0.0`
- [npm](https://www.npmjs.com/) `>= 9.0.0`
- [Git](https://git-scm.com/)

### Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/docrot/docrot.git
cd docrot

# 2. Install dependencies
npm install

# 3. Build the TypeScript project
npm run build
```

### Running Locally

```bash
# Option A: Link globally to use `docrot` from anywhere in your terminal
npm link
docrot check

# Option B: Run the compiled distribution directly with Node
node ./dist/cli.js check

# Option C: Run directly from TypeScript source using tsx
npx tsx src/cli.ts check
```

---

## Usage

```bash
# Scan the current working directory
docrot check

# Scan a specific directory
docrot check ./docs

# Scan a single Markdown file
docrot check README.md

# Output pure, machine-readable JSON (ideal for CI/CD)
docrot check --json

# Scan only documentation files changed relative to Git HEAD
docrot check --changed

# Initialize a starter .docrotrc.json configuration file
docrot init

# Display installed CLI version
docrot --version

# Display help and command options
docrot --help
```

### PowerShell Examples (Windows)

```powershell
# Run check (returns exit code 0 on success, 1 on documentation errors)
node ./dist/cli.js check .

# Parse JSON report directly in PowerShell
node ./dist/cli.js check --json | ConvertFrom-Json

# Run check on a specific subdirectory
node ./dist/cli.js check test-fixture
```

---

## Example Findings

| Rule ID | Default Severity | Description | Actionable Guidance |
|---|---|---|---|
| `link/missing-target` | **ERROR** | Relative link or image path does not exist on disk. | Create the file or update the link target. |
| `link/invalid-fragment` | **WARNING** | Heading anchor `#anchor` not found in target file. | Update the anchor slug to match the heading. |
| `link/broken-reference` | **ERROR** | Reference link `[text][ref]` lacks `[ref]: ...` definition. | Add the reference definition or convert to inline link. |
| `link/malformed-path` | **ERROR** | Path contains invalid URI characters or malformed encoding. | Check for syntax errors or invalid percent-encoding. |
| `npm/missing-script` | **ERROR** | Documented script is missing from `package.json`. | Add script to `package.json` or update documentation. |
| `make/missing-target` | **ERROR** | Documented target does not exist in `Makefile`. | Add rule to `Makefile` or update documented command. |
| `env/missing-example` | **WARNING** | Environment variable is documented but absent from `.env.example`. | Add key to `.env.example` or correct spelling. |

---

## Exit Codes

docrot follows standard POSIX exit code conventions for predictable automation and CI integration:

| Exit Code | Meaning | Details |
|---|---|---|
| `0` | **Success** | Scan completed with no errors. **Warnings alone do not cause exit code 1.** |
| `1` | **Documentation Errors** | Scan found one or more errors (`link/missing-target`, `npm/missing-script`, `make/missing-target`, etc.). |
| `2` | **Fatal / Argument Error** | Inaccessible path, invalid JSON configuration, or invalid CLI options. |

---

## Configuration

Generate a starter configuration with:

```bash
docrot init
```

This creates a `.docrotrc.json` file in the target directory:

```json
{
  "ignore": [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "vendor",
    "test-fixture"
  ],
  "rules": {
    "link/missing-target": "error",
    "link/invalid-fragment": "warning",
    "link/broken-reference": "error",
    "link/malformed-path": "error",
    "npm/missing-script": "error",
    "make/missing-target": "error",
    "env/missing-example": "warning"
  }
}
```

### Configuration Options

- **`ignore`**: Array of relative paths or glob patterns to exclude from scanning. Patterns cannot escape the repository root.
- **`rules`**: Map of rule IDs to desired severities:
  - `"error"`: Fails the scan with exit code `1`.
  - `"warning"`: Reports the issue; returns exit code `0` if no errors exist.
  - `"info"`: Informational notice.
  - `"off"` or `false`: Disables rule evaluation.

---

## How It Works

```text
 1. Discovery & Normalization
    Traverse Markdown files with symlink loop detection and .docrotrc.json ignore filtering.
    ───►
 2. Context Harvesting
    Read package.json scripts, Makefile targets, and .env.example keys.
    ───►
 3. Unified AST Analysis
    Parse Markdown with remark-parse; extract links, code blocks, anchors, and references.
    ───►
 4. Concurrent Cross-Verification
    Verify links against disk, scripts against package.json, targets against Makefile,
    and env vars against .env.example. (Never executes shell commands).
    ───►
 5. Deterministic Reporting & Exit Codes
    Output sorted, grouped terminal findings or pure machine-readable JSON.
```

---

## Tech Stack

- **Runtime**: [Node.js](https://nodejs.org/) (ES Modules, `>= 20.0.0`)
- **Language**: [TypeScript 5.7](https://www.typescriptlang.org/)
- **Markdown AST Engine**: [Unified](https://unifiedjs.com/), [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse), [unist-util-visit](https://github.com/syntax-tree/unist-util-visit)
- **CLI Framework**: [Commander 13](https://github.com/tj/commander.js/)
- **Test Runner**: [Vitest 3](https://vitest.dev/)

---

## Project Structure

```text
docrot/
├── dist/                  # Compiled JavaScript distribution
├── src/
│   ├── checks/            # Static rule analyzers
│   │   ├── env-vars.ts    # Environment variable extraction & verification
│   │   ├── links.ts       # Relative links, images, anchors & references
│   │   ├── make-targets.ts# Makefile target & pattern rule analysis
│   │   └── scripts.ts     # Package manager (npm/pnpm/yarn/bun) script validation
│   ├── reporters/         # Output formatters
│   │   ├── json.ts        # Pure JSON output formatter
│   │   └── terminal.ts    # Grouped human-readable terminal output
│   ├── utils/             # Cross-platform utilities
│   │   ├── color.ts       # Terminal ANSI colors with NO_COLOR support
│   │   ├── fs.ts          # Safe async fs operations & UTF-16/BOM decoding
│   │   ├── git.ts         # Git status and diff inspection
│   │   └── markdown.ts    # AST parsing, HTML anchor & slug extraction
│   ├── cli.ts             # CLI command definitions & entry point
│   ├── config.ts          # Configuration loader, validator & initializer
│   ├── scanner.ts         # Core orchestrator pipeline
│   ├── types.ts           # Shared TypeScript interfaces & types
│   └── index.ts           # Programmatic API exports
├── tests/                 # Vitest test suite (82 tests across 7 suites)
├── .docrotrc.json         # Project configuration
├── .env.example           # Documented environment variables
├── Makefile               # Repository automation targets
├── package.json           # Dependencies and project metadata
└── tsconfig.json          # TypeScript compiler configuration
```

---

## Testing

docrot maintains a comprehensive test suite covering all checks, edge cases, and CLI integration behaviors.

```bash
# Run Vitest test suite
npm test

# Run TypeScript strict typecheck
npm run typecheck

# Build compiled distribution to ./dist
npm run build

# Run prepublish validation (build + test)
npm run prepublishOnly
```

---

## Roadmap

### Current (Implemented)
- [x] Relative link, directory link, and root-relative path checking
- [x] Heading slug anchor (`#anchor`) and HTML `<a id="...">` validation
- [x] Reference-style link definition validation (`[text][ref]`)
- [x] Image file path validation (`![alt](./path)` and `<img src="..." />`)
- [x] npm, pnpm, yarn, and bun script validation with lifecycle awareness
- [x] Makefile target validation with `.PHONY`, pattern rules, and default targets
- [x] Environment variable auditing against `.env.example` with typo suggestions
- [x] Human-readable terminal output and machine-readable `--json` output
- [x] Configuration via `.docrotrc.json` and `docrot init`
- [x] Git-aware differential scanning with `--changed`
- [x] Single-file direct scanning (`docrot check README.md`)

### Planned (Future Releases)
- [ ] Automated fix mode (`--fix`) for broken anchors and renamed script references
- [ ] External HTTP link checking mode (`--check-external`) with rate limiting
- [ ] Pre-commit hook integration recipe (Husky & lint-staged)
- [ ] Official GitHub Action for workflow automation

---

## Security

1. **Zero Command Execution**: docrot performs static syntax analysis only. It **never runs** shell scripts, npm commands, or Make targets documented in Markdown.
2. **Secret Isolation**: docrot inspects only template files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`). It strictly ignores `.env`, `.env.local`, and other secret files, and never outputs secret values.
3. **Sandbox Traversal**: Path resolution and ignore patterns cannot escape the repository root.
4. **Symlink Safety**: Directory traversal tracks canonical realpaths to detect and stop infinite symlink recursion.

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository and create your feature branch:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Ensure all tests pass:
   ```bash
   npm test
   ```
4. Verify TypeScript compilation:
   ```bash
   npm run typecheck
   ```
5. Test docrot against its own documentation:
   ```bash
   node ./dist/cli.js check .
   ```
6. Commit your changes and open a pull request describing your improvements.

---

## License and Author

This project is open-source software licensed under the [MIT License](./LICENSE).

Copyright (c) 2026 docrot contributors.
