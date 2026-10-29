import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkEnvVars,
  parseEnvExample,
  extractDocEnvVars,
  findSpellingCandidate,
} from "../src/checks/env-vars.js";
import type { CheckContext } from "../src/types.js";

describe("Environment Variables Checker", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-env-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("parseEnvExample", () => {
    it("parses variable names ignoring blank lines and comments", () => {
      const content = `
# Database configuration
DATABASE_URL=postgres://user:pass@localhost:5432/db # connection
PORT=3000

# Authentication
export JWT_SECRET=supersecret
API_KEY=
`;
      const vars = parseEnvExample(content);
      expect(vars).toEqual(["DATABASE_URL", "PORT", "JWT_SECRET", "API_KEY"]);
    });
  });

  describe("extractDocEnvVars", () => {
    it("recognizes common env var forms: process.env, ${VAR}, $VAR, assignments, uppercase with underscore", () => {
      const text = `
const db = process.env.DATABASE_URL;
const key = process.env['API_KEY'];
const port = \${PORT};
echo $SECRET_KEY
export REDIS_HOST=localhost
Configure your STRIPE_SECRET_KEY in the environment.
`;
      const detected = extractDocEnvVars(text, { line: 1 });
      const names = detected.map((d) => d.name);

      expect(names).toContain("DATABASE_URL");
      expect(names).toContain("API_KEY");
      expect(names).toContain("PORT");
      expect(names).toContain("SECRET_KEY");
      expect(names).toContain("REDIS_HOST");
      expect(names).toContain("STRIPE_SECRET_KEY");
    });

    it("does not report arbitrary uppercase words as environment variables", () => {
      const text = `
Please read the README and the LICENSE (MIT).
Send an HTTP GET or POST request to the API.
Use the CLI or the GUI with JSON responses.
`;
      const detected = extractDocEnvVars(text);
      expect(detected).toHaveLength(0);
    });
  });

  describe("spelling suggestions", () => {
    it("suggests the closest variable name for minor typos or naming differences", () => {
      const available = ["DATABASE_URL", "PORT", "AUTH_SECRET"];
      expect(findSpellingCandidate("DATABASE_URI", available)).toBe("DATABASE_URL");
      expect(findSpellingCandidate("database_url", available)).toBe("DATABASE_URL");
      expect(findSpellingCandidate("DATABASEURL", available)).toBe("DATABASE_URL");
      expect(findSpellingCandidate("PORRT", available)).toBe("PORT");
      expect(findSpellingCandidate("COMPLETELY_UNRELATED", available)).toBeNull();
    });
  });

  describe("checkEnvVars execution", () => {
    it("detects documented variables missing from .env.example and provides suggestions", async () => {
      const envExamplePath = path.join(tempDir, ".env.example");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(
        envExamplePath,
        "DATABASE_URL=postgres://localhost\nPORT=3000\n"
      );
      await fs.writeFile(
        readmePath,
        `# Configuration\n\nSet \`DATABASE_URI\` in your environment.\nAlso configure \`MISSING_TOKEN\`.\nMake sure \`PORT\` is set.`
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        envExample: {
          path: envExamplePath,
          variables: ["DATABASE_URL", "PORT"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkEnvVars(context);
      expect(findings).toHaveLength(2);

      const typoFinding = findings.find((f) => f.message.includes("DATABASE_URI"));
      expect(typoFinding).toBeDefined();
      expect(typoFinding?.suggestion).toContain("Did you mean 'DATABASE_URL'?");

      const missingFinding = findings.find((f) => f.message.includes("MISSING_TOKEN"));
      expect(missingFinding).toBeDefined();
      expect(missingFinding?.suggestion).toContain("Add 'MISSING_TOKEN' to .env.example");
    });

    it("skips gracefully when no .env.example is present", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "Set `DATABASE_URL=postgres`");

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        config: { ignore: [], rules: {} },
      };

      const findings = await checkEnvVars(context);
      expect(findings).toHaveLength(0);
    });

    it("Phase 2: recognizes import.meta.env and optional chaining process.env?.VAR", () => {
      const text = `
const apiUrl = import.meta.env.VITE_API_URL;
const clientKey = import.meta.env['VITE_CLIENT_KEY'];
const secret = process.env?.API_SECRET;
const token = process.env?.['AUTH_TOKEN'];
`;
      const detected = extractDocEnvVars(text);
      const names = detected.map((d) => d.name);
      expect(names).toContain("VITE_API_URL");
      expect(names).toContain("VITE_CLIENT_KEY");
      expect(names).toContain("API_SECRET");
      expect(names).toContain("AUTH_TOKEN");
    });

    it("Phase 2: recognizes shell parameter expansion with defaults like \${PORT:-3000}", () => {
      const text = `
PORT=\${PORT:-3000}
DB_CONN=\${DATABASE_URL:=postgres://localhost:5432/db}
REQUIRED=\${CRITICAL_SECRET:?must be set}
`;
      const detected = extractDocEnvVars(text);
      const names = detected.map((d) => d.name);
      expect(names).toContain("PORT");
      expect(names).toContain("DATABASE_URL");
      expect(names).toContain("CRITICAL_SECRET");
    });

    it("Phase 2: suggests framework prefix matches", () => {
      const available = ["API_URL", "DATABASE_URL"];
      // VITE_API_URL should suggest API_URL
      expect(findSpellingCandidate("VITE_API_URL", available)).toBe("API_URL");
    });

    it("Phase 2: supports fallback to .env.sample, .env.template, or .env.dist", async () => {
      const samplePath = path.join(tempDir, ".env.sample");
      await fs.writeFile(samplePath, "FALLBACK_VAR=true\n");

      const { loadEnvExample } = await import("../src/checks/env-vars.js");
      const info = await loadEnvExample(tempDir);
      expect(info).not.toBeNull();
      expect(info?.variables).toContain("FALLBACK_VAR");
    });

    it("Phase 2: detects env vars in markdown tables and prose outside code blocks", async () => {
      const envExamplePath = path.join(tempDir, ".env.example");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(envExamplePath, "DATABASE_URL=postgres://localhost\n");
      await fs.writeFile(
        readmePath,
        `# Environment\n\n| Variable | Description |\n| UNCONFIGURED_KEY | Secret token for external API |\n`
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        envExample: {
          path: envExamplePath,
          variables: ["DATABASE_URL"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkEnvVars(context);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("UNCONFIGURED_KEY");
    });

    it("recognizes DATABASE_URL, process .env.API_KEY, ${PORT}, and $SECRET_KEY patterns", () => {
      const text = `
Connect to DATABASE_URL in your database config.
The API key is accessed via process .env.API_KEY or process.env.API_KEY.
Listening on port \${PORT}.
Authentication requires $SECRET_KEY.
`;
      const detected = extractDocEnvVars(text);
      const names = detected.map((d) => d.name);
      expect(names).toContain("DATABASE_URL");
      expect(names).toContain("API_KEY");
      expect(names).toContain("PORT");
      expect(names).toContain("SECRET_KEY");
    });

    it("handles present variables and reports missing variables with rule ID env/missing-example", async () => {
      const envExamplePath = path.join(tempDir, ".env.example");
      const readmePath = path.join(tempDir, "README.md");

      // .env.example contains DATABASE_URL and PORT, but misses API_KEY and SECRET_KEY
      await fs.writeFile(
        envExamplePath,
        `
# Database
DATABASE_URL=postgres://localhost:5432/mydb

# Server
PORT=3000
`
      );

      await fs.writeFile(
        readmePath,
        `# Setup

\`DATABASE_URL\` is configured in .env.example.
Set port with \`\${PORT}\`.
Missing key: \`process.env.API_KEY\`.
Missing secret: \`$SECRET_KEY\`.
`
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        envExample: {
          path: envExamplePath,
          variables: ["DATABASE_URL", "PORT"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkEnvVars(context);
      // DATABASE_URL and PORT are present -> no finding
      // API_KEY and SECRET_KEY are missing -> 2 findings
      expect(findings).toHaveLength(2);

      const apiKeyFinding = findings.find((f) => f.message.includes("'API_KEY'"));
      expect(apiKeyFinding).toBeDefined();
      expect(apiKeyFinding?.ruleId).toBe("env/missing-example");
      expect(apiKeyFinding?.suggestion).toContain("Add 'API_KEY' to .env.example");

      const secretKeyFinding = findings.find((f) => f.message.includes("'SECRET_KEY'"));
      expect(secretKeyFinding).toBeDefined();
      expect(secretKeyFinding?.ruleId).toBe("env/missing-example");
      expect(secretKeyFinding?.suggestion).toContain("Add 'SECRET_KEY' to .env.example");
    });

    it("ignores comments and blank lines in .env.example", () => {
      const exampleContent = `
# Global comment
#

DATABASE_URL=postgres://user:pass@localhost:5432/db # with inline comment

# Auth section

API_KEY= # empty value
PORT=8080

# Trailing comments
# END
`;
      const vars = parseEnvExample(exampleContent);
      expect(vars).toEqual(["DATABASE_URL", "API_KEY", "PORT"]);
      expect(vars).not.toContain("#");
      expect(vars).not.toContain("Global comment");
      expect(vars).not.toContain("");
    });

    it("avoids arbitrary uppercase words as false positives", async () => {
      const envExamplePath = path.join(tempDir, ".env.example");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(envExamplePath, "DATABASE_URL=postgres://localhost\n");
      await fs.writeFile(
        readmePath,
        `# Overview
Please check the README and LICENSE (MIT).
Send an HTTP GET or POST request to the REST API with JSON responses.
Use the CLI or GUI with UUID and URI.
Boolean values TRUE and FALSE or NULL are returned.
`
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        envExample: {
          path: envExamplePath,
          variables: ["DATABASE_URL"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkEnvVars(context);
      // None of the common uppercase words should be reported as missing env vars!
      expect(findings).toHaveLength(0);
    });

    it("never reads .env or exposes secret values", async () => {
      // Create a .env file with actual secret values
      const secretEnvPath = path.join(tempDir, ".env");
      await fs.writeFile(secretEnvPath, "SUPER_SECRET_TOKEN=super_secret_value_12345\n");

      // No .env.example present
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "Configure `SUPER_SECRET_TOKEN` before running.");

      const { loadEnvExample } = await import("../src/checks/env-vars.js");
      const info = await loadEnvExample(tempDir);
      // Must not read .env!
      expect(info).toBeNull();
    });
  });
});
