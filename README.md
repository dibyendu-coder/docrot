# docrot — Documentation Rot Detector CLI

[![CI](https://github.com/docrot/docrot/actions/workflows/ci.yml/badge.svg)](https://github.com/docrot/docrot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**docrot** is a production-minded developer tool that detects outdated, broken, or inconsistent documentation in software repositories.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Usage & Commands](#usage-commands)
- [Supported Checks](#supported-checks)
- [Exit Codes](#exit-codes)
- [Configuration](#configuration)
- [Continuous Integration (CI)](#continuous-integration-ci)
- [Security Considerations](#security-considerations)
- [Local Development](#local-development)
- [Contributing](#contributing)
- [License](#license)

---

## The Problem

Developers trust documentation and README files, then waste time when:
- File paths or screenshots referenced in docs have moved or been deleted.
- Documented npm scripts were renamed or removed from `package.json`.
- Documented Make targets no longer exist in the `Makefile`.
- Required environment variables are documented in Markdown but missing or misspelled in `.env.example`.

**docrot** catches these discrepancies automatically before developers or contributors encounter them.

---

## Features

- **Offline-First Markdown Analysis**: Uses Unified and `remark-parse` to construct ASTs and detect broken relative links, missing images, invalid heading anchors, and broken reference-style definitions.
- **npm Script Validation**: Scans documented commands (`npm run <script>`, `npm test`, `npm start`) and verifies them against `package.json` scripts, including npm lifecycle conventions.
- **Make Target Validation**: Validates documented `make <target>` calls against declared targets in `Makefile` (including `.PHONY`).
- **Environment Variable Auditing**: Compares documented environment variables (`process.env.VAR_NAME`, `${VAR_NAME}`, `$VAR_NAME`) against `.env.example`, with intelligent typo and spelling suggestions.
- **Fast & Safe**:
  - Traverses directory trees with symlink loop detection.
  - Never executes shell commands found in documentation.
  - Never reads `.env` secrets (only `.env.example`).
  - Supports `--changed` to scan only modified documentation relative to Git HEAD.
- **Professional Output**: Clean, readable terminal reporting supporting `NO_COLOR`, and machine-readable `--json` format for automated toolchains.

---

## Installation

### Run without installing (via npx)

```bash
npx docrot check
```

### Install as a project dependency

```bash
npm install --save-dev docrot
```

### Install globally

```bash
npm install -g docrot
```

---

## Usage & Commands

```bash
# Scan the current working directory
docrot check

# Scan a specific directory
docrot check ./docs

# Output machine-readable JSON (ideal for CI and tool integrations)
docrot check --json

# Scan only documentation files changed relative to Git HEAD
docrot check --changed

# Create a starter .docrotrc.json configuration file
docrot init

# Display version
docrot --version

# Display help and available options
docrot --help
```

---

## Supported Checks

### 1. Markdown Links and References
- **Broken Relative Links**: Verifies that relative file and directory targets exist on disk.
- **Missing Local Images**: Validates that image paths in `![alt](./image.png)` or `<img src="..." />` point to real files.
- **Invalid Fragment References**: Validates `#heading-anchor` links against actual Markdown headings and explicit HTML `<a id="...">` / `<a name="...">` anchors in the target document.
- **Broken Reference-Style Links**: Catches reference-style links (such as `[text][ref]`) where `[ref]: ...` was never defined.
- **Root-Relative Links**: Resolves `/docs/page.md` relative to the repository root.
- **URL Encoding & Spaces**: Properly decodes URL-encoded paths (such as `%20`) and spaces.
- **External Protocol Skipping**: Ignores external URLs (`http://`, `https://`, `mailto:`, `tel:`, etc.) during offline scans.

### 2. npm Script Validation
- Detects documented commands in code blocks and inline text:
  - `npm run <script>`
  - `npm run-script <script>`
  - `npm test` (and lifecycle aliases `npm t`, `npm tst`)
  - `npm start` (with `server.js` fallback awareness)
- Compares requested scripts against `scripts` in `package.json`.
- Safely skips unrelated npm commands (`npm install`, `npm publish`, `npm audit`, `npx`).
- Gracefully skips validation if no `package.json` exists in the repository.

### 3. Make Target Validation
- Scans `Makefile` for declared rules and `.PHONY` prerequisites.
- Identifies documented `make <target>` commands (handling prompt symbols `$`, `-j` flags, variable overrides, and compound commands).
- Reports missing Make targets.
- Gracefully skips validation if no `Makefile` exists in the repository.

### 4. Environment Variable Validation
- Extracts environment variables documented across Markdown:
  - `process.env.VAR_NAME` or `process.env['VAR_NAME']`
  - `${VAR_NAME}`
  - `$VAR_NAME`
  - `export VAR_NAME=...` or `VAR_NAME=value`
- Compares extracted names against `.env.example`.
- Provides typo suggestions when a variable name closely resembles one in `.env.example`.
- Skips plain English uppercase words (`README`, `API`, `HTTP`, `JSON`, `MIT`, `GET`, `POST`).
- Never inspects `.env` files and never outputs secrets.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Scan completed successfully with no errors (warnings alone do not fail). |
| `1` | Scan completed and found one or more errors. |
| `2` | Fatal error: invalid CLI arguments, inaccessible directory, or invalid configuration. |

---

## Configuration

Initialize a starter configuration with:

```bash
docrot init
```

This creates `.docrotrc.json` in the target directory:

```json
{
  "ignore": [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "vendor"
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

- **`ignore`**: Array of relative path or glob patterns to exclude from scans.
- **`rules`**: Map of rule IDs to their desired severity (`"error"`, `"warning"`, `"info"`, `"off"`, or `true`/`false`).

Available rules:
- `link/missing-target`
- `link/invalid-fragment`
- `link/broken-reference`
- `link/malformed-path`
- `npm/missing-script`
- `make/missing-target`
- `env/missing-example`

---

## Continuous Integration (CI)

To run docrot in GitHub Actions:

```yaml
name: Documentation Health

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  docrot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx docrot check
```

---

## Security Considerations

1. **No Code Execution**: docrot inspects command strings statically. It never executes documented commands or scripts.
2. **Secret Privacy**: docrot only reads `.env.example`. It strictly ignores `.env`, `.env.local`, and other secret files.
3. **Sandbox Traversal**: Ignore patterns and path resolution cannot escape the repository root.
4. **Symlink Safety**: Traversal tracks realpaths to detect and stop circular symlinks.

---

## Local Development

Requirements: Node.js 20+ and npm.

```bash
# Clone the repository
git clone https://github.com/docrot/docrot.git
cd docrot

# Install dependencies
npm install

# Run test suite
npm test

# Run TypeScript compiler checks
npm run typecheck

# Build the project
npm run build

# Run local CLI
node ./dist/cli.js check .
```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository and create your feature branch.
2. Ensure all tests pass with `npm test`.
3. Ensure TypeScript strict checks pass with `npm run typecheck`.
4. Test the CLI against your changes using `node ./dist/cli.js check .`.
5. Open a pull request describing your improvements.

---

## License

This project is open-source software licensed under the [MIT License](./LICENSE).
