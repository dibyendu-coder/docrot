import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkScripts, extractNpmScriptInvocations } from "../src/checks/scripts.js";
import type { CheckContext } from "../src/types.js";

describe("NPM Scripts Checker", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-scripts-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("extractNpmScriptInvocations", () => {
    it("extracts npm run scripts with prompt symbols and flags", () => {
      const text = `$ npm run build -- --production\n# npm run lint\n> npm run test:unit`;
      const detected = extractNpmScriptInvocations(text, { line: 10 });
      expect(detected).toHaveLength(3);
      expect(detected[0].scriptName).toBe("build");
      expect(detected[0].position?.line).toBe(10);
      expect(detected[1].scriptName).toBe("lint");
      expect(detected[1].position?.line).toBe(11);
      expect(detected[2].scriptName).toBe("test:unit");
      expect(detected[2].position?.line).toBe(12);
    });

    it("extracts lifecycle commands like npm test and npm start", () => {
      const text = `npm test\nnpm start\nnpm t`;
      const detected = extractNpmScriptInvocations(text);
      expect(detected).toHaveLength(3);
      expect(detected[0].scriptName).toBe("test");
      expect(detected[1].scriptName).toBe("start");
      expect(detected[2].scriptName).toBe("test");
    });

    it("handles compound commands with && and ||", () => {
      const text = `npm run clean && npm run build || npm test`;
      const detected = extractNpmScriptInvocations(text);
      expect(detected.map((d) => d.scriptName)).toEqual(["clean", "build", "test"]);
    });

    it("does not treat standard npm CLI commands as scripts", () => {
      const text = `npm install\nnpm ci\nnpm publish\nnpm audit\nnpx create-app`;
      const detected = extractNpmScriptInvocations(text);
      expect(detected).toHaveLength(0);
    });
  });

  describe("checkScripts execution", () => {
    it("detects missing scripts and validates existing scripts", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(
        readmePath,
        `# Project\n\n\`\`\`bash\nnpm run build\nnpm run deploy-old\n\`\`\`\n\nRun \`npm test\` to run tests.`
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        packageJson: {
          path: path.join(tempDir, "package.json"),
          scripts: {
            build: "tsc",
            test: "vitest",
          },
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkScripts(context);
      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("npm/missing-script");
      expect(findings[0].message).toContain("npm script does not exist: deploy-old");
    });

    it("skips gracefully when no package.json is present", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "```bash\nnpm run build\n```");

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        config: { ignore: [], rules: {} },
      };

      const findings = await checkScripts(context);
      expect(findings).toHaveLength(0);
    });

    it("recognizes npm start lifecycle when server.js is present", async () => {
      const readmePath = path.join(tempDir, "README.md");
      const serverPath = path.join(tempDir, "server.js");
      await fs.writeFile(serverPath, "console.log('server');");
      await fs.writeFile(readmePath, "```bash\nnpm start\n```");

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        packageJson: {
          path: path.join(tempDir, "package.json"),
          scripts: {}, // no start script, but server.js exists
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkScripts(context);
      expect(findings).toHaveLength(0);
    });

    it("Phase 2: validates pnpm, yarn, and bun script commands", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(
        readmePath,
        `\`\`\`bash\npnpm run build\nyarn run test\nbun run missing-script\n\`\`\``
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        packageJson: {
          path: path.join(tempDir, "package.json"),
          scripts: {
            build: "tsc",
            test: "vitest",
          },
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkScripts(context);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("missing-script");
    });
  });
});
