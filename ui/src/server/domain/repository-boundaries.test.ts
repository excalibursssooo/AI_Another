import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");
const LEGACY_REPOSITORY_IMPORT = /from\s+["'](?:@\/server\/domain\/chat\/repositories|\.\/repositories)["']/;
const IGNORED_FILES = new Set([
  "server/domain/chat/repositories.ts",
  "server/domain/memory/memory-repository.ts",
]);

describe("repository import boundaries", () => {
  it("imports domain repositories through domain-specific modules", () => {
    const offenders = listTypeScriptFiles(SRC_ROOT)
      .map((file) => ({ file, relativePath: relative(SRC_ROOT, file) }))
      .filter(({ relativePath }) => !IGNORED_FILES.has(relativePath))
      .filter(({ file }) => LEGACY_REPOSITORY_IMPORT.test(readFileSync(file, "utf8")))
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });
});

function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
