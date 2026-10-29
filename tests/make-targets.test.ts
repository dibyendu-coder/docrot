import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkMakeTargets,
  parseMakefileTargets,
  extractMakeInvocations,
} from "../src/checks/make-targets.js";
import type { CheckContext } from "../src/types.js";

describe("Make Targets Checker", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrot-make-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("parseMakefileTargets", () => {
    it("handles ordinary targets, assignments, and .PHONY targets", () => {
      const makefileContent = `
# Makefile comment
CC = gcc
CFLAGS ?= -Wall -O2

.PHONY: all clean test

all: build

build:
\t$(CC) main.c -o app

clean:
\trm -f app

test: build
\t./test.sh
`;
      const { targets, defaultTarget } = parseMakefileTargets(makefileContent);
      expect(targets.has("all")).toBe(true);
      expect(targets.has("clean")).toBe(true);
      expect(targets.has("test")).toBe(true);
      expect(targets.has("build")).toBe(true);
      expect(defaultTarget).toBe("all");
      expect(targets.has("CC")).toBe(false);
      expect(targets.has("CFLAGS")).toBe(false);
    });

    it("handles line continuations in Makefile targets", () => {
      const content = `
multi-target1 \\
multi-target2:
\techo "multi"
`;
      const { targets } = parseMakefileTargets(content);
      expect(targets.has("multi-target1")).toBe(true);
      expect(targets.has("multi-target2")).toBe(true);
    });
  });

  describe("extractMakeInvocations", () => {
    it("extracts make commands with flags, variables, and prompts", () => {
      const text = `$ make build\nmake -j4 test\nmake clean && make -C ./docs html\nmake VAR=val deploy`;
      const detected = extractMakeInvocations(text, { line: 5 });

      expect(detected.map((d) => d.target)).toEqual(["build", "test", "clean", "html", "deploy"]);
      expect(detected[0].position?.line).toBe(5);
    });

    it("extracts bare make as default target indicator", () => {
      const text = `Run \`make\` to build everything.`;
      const detected = extractMakeInvocations(text);
      expect(detected).toHaveLength(1);
      expect(detected[0].target).toBe("@default");
    });
  });

  describe("checkMakeTargets execution", () => {
    it("detects missing make targets and validates existing ones", async () => {
      const makefilePath = path.join(tempDir, "Makefile");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(
        makefilePath,
        `.PHONY: build test\nbuild:\n\techo build\ntest:\n\techo test\n`
      );
      await fs.writeFile(
        readmePath,
        `# Build\n\n\`\`\`bash\nmake build\nmake outdated-target\n\`\`\``
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        makefile: {
          path: makefilePath,
          targets: ["build", "test"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      expect(findings).toHaveLength(1);
      expect(findings[0].ruleId).toBe("make/missing-target");
      expect(findings[0].message).toContain("Make target does not exist: outdated-target");
    });

    it("skips gracefully when no Makefile is present", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "```bash\nmake build\n```");

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      expect(findings).toHaveLength(0);
    });

    it("Phase 2: supports pattern rules like test-% and %.o without false positives", async () => {
      const makefilePath = path.join(tempDir, "Makefile");
      const readmePath = path.join(tempDir, "README.md");

      await fs.writeFile(
        makefilePath,
        `.PHONY: all\nall: build\nbuild:\n\techo build\ntest-%:\n\techo testing $*\n%.o: %.c\n\tgcc -c $< -o $@\n`
      );
      await fs.writeFile(
        readmePath,
        `# Testing\n\n\`\`\`bash\nmake test-unit\nmake test-e2e\nmake main.o\nmake nonexistent\n\`\`\``
      );

      const { targets } = parseMakefileTargets(await fs.readFile(makefilePath, "utf-8"));
      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        makefile: {
          path: makefilePath,
          targets: Array.from(targets),
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      // Only 'nonexistent' should be reported as missing; test-unit, test-e2e, and main.o match pattern rules!
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain("Make target does not exist: nonexistent");
    });

    it("Phase 2: strips trailing comments and ignores recipe lines with colons", async () => {
      const makefileContent = `
.PHONY: build test # phonies
build: # build rule
\tdocker run -p 8080:80 app:latest
\tsed -e 's/:/ /g' file.txt

test: build # test rule
\techo done
`;
      const { targets } = parseMakefileTargets(makefileContent);
      expect(targets.has("build")).toBe(true);
      expect(targets.has("test")).toBe(true);
      // Comments and recipe items should NOT be targets
      expect(targets.has("#")).toBe(false);
      expect(targets.has("phonies")).toBe(false);
      expect(targets.has("docker")).toBe(false);
      expect(targets.has("app:latest")).toBe(false);
    });

    it("Phase 2: honors .DEFAULT_GOAL in Makefile", () => {
      const content = `
.DEFAULT_GOAL := release

build:
\techo build

release:
\techo release
`;
      const { defaultTarget } = parseMakefileTargets(content);
      expect(defaultTarget).toBe("release");
    });

    it("Phase 2: parses targets from included makefiles", async () => {
      const mainMakefile = path.join(tempDir, "Makefile");
      const subMakefile = path.join(tempDir, "docker.mk");

      await fs.writeFile(mainMakefile, `include docker.mk\nbuild:\n\techo build\n`);
      await fs.writeFile(subMakefile, `docker-build:\n\tdocker build .\n`);

      const { loadMakefile } = await import("../src/checks/make-targets.js");
      const info = await loadMakefile(tempDir);
      expect(info).not.toBeNull();
      expect(info?.targets).toContain("build");
      expect(info?.targets).toContain("docker-build");
    });

    it("Phase 2: extracts $(MAKE) and ${MAKE} commands", () => {
      const text = `$(MAKE) compile\n\${MAKE} test\nmake clean`;
      const detected = extractMakeInvocations(text);
      expect(detected.map((d) => d.target)).toEqual(["compile", "test", "clean"]);
    });

    it("detects make build and make deploy, compares against Makefile, and reports missing targets with file, line, ruleId, and actionable suggestion", async () => {
      const makefilePath = path.join(tempDir, "Makefile");
      const readmePath = path.join(tempDir, "README.md");

      // Makefile defines `build` but missing `deploy`
      await fs.writeFile(
        makefilePath,
        `# Project Makefile\nCC = gcc\n\n.PHONY: build\nbuild:\n\t$(CC) main.c -o app\n`
      );

      // Markdown documents valid `make build` and missing `make deploy`
      await fs.writeFile(
        readmePath,
        `# Guide\n\nTo build the app:\n\`\`\`bash\nmake build\n\`\`\`\n\nTo deploy:\n\`\`\`bash\nmake deploy\n\`\`\``
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        makefile: {
          path: makefilePath,
          targets: ["build"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      expect(findings).toHaveLength(1);

      const finding = findings[0];
      expect(finding.file).toBe("README.md");
      expect(finding.line).toBe(9);
      expect(finding.ruleId).toBe("make/missing-target");
      expect(finding.message).toBe("Make target does not exist: deploy");
      expect(finding.suggestion).toBe('Add the "deploy" target to Makefile or update the documentation.');
    });

    it("verifies valid targets succeed with zero findings", async () => {
      const makefilePath = path.join(tempDir, "Makefile");
      const readmePath = path.join(tempDir, "README.md");

      // Makefile defines both `build` and `deploy`
      await fs.writeFile(
        makefilePath,
        `.PHONY: build deploy\nbuild:\n\techo build\ndeploy:\n\techo deploy\n`
      );

      await fs.writeFile(
        readmePath,
        `\`\`\`bash\nmake build\nmake deploy\n\`\`\``
      );

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        makefile: {
          path: makefilePath,
          targets: ["build", "deploy"],
        },
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      expect(findings).toHaveLength(0);
    });

    it("ignores comments and variable assignments in Makefile and CLI flags", () => {
      const makefileContent = `
# Header comment
# Another comment line
CC = gcc
CFLAGS := -Wall -O3
LDFLAGS ?= -lm
LIBS += -lpthread
VAR ::= immediate
SHELL_RES != echo hi
export GLOBAL_VAR = 1
override OVERRIDE_VAR = 2

define MULTILINE_VAR
echo hello
endef

.PHONY: build deploy # inline comment

build: # target comment
\techo building

deploy:
\techo deploying
`;
      const { targets } = parseMakefileTargets(makefileContent);
      expect(targets.has("build")).toBe(true);
      expect(targets.has("deploy")).toBe(true);

      // Comments and variables must NOT be targets
      expect(targets.has("#")).toBe(false);
      expect(targets.has("CC")).toBe(false);
      expect(targets.has("CFLAGS")).toBe(false);
      expect(targets.has("LDFLAGS")).toBe(false);
      expect(targets.has("LIBS")).toBe(false);
      expect(targets.has("VAR")).toBe(false);
      expect(targets.has("SHELL_RES")).toBe(false);
      expect(targets.has("GLOBAL_VAR")).toBe(false);
      expect(targets.has("OVERRIDE_VAR")).toBe(false);
      expect(targets.has("MULTILINE_VAR")).toBe(false);
      expect(targets.has("define")).toBe(false);
      expect(targets.has("inline")).toBe(false);
      expect(targets.has("comment")).toBe(false);

      // Invocations with variables ignored:
      const invocations = extractMakeInvocations("make CC=clang build\nmake deploy ENV=prod");
      expect(invocations.map((i) => i.target)).toEqual(["build", "deploy"]);
    });

    it("handles a missing Makefile gracefully with zero findings", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "```bash\nmake build\nmake deploy\n```");

      const context: CheckContext = {
        rootDir: tempDir,
        markdownFiles: [readmePath],
        makefile: undefined, // No Makefile present in repository
        config: { ignore: [], rules: {} },
      };

      const findings = await checkMakeTargets(context);
      expect(findings).toEqual([]);
    });
  });
});
