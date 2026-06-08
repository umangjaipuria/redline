import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TEST_ARTIFACTS = process.env.REDLINE_TEST_ARTIFACTS ?? path.join(ROOT, ".test-artifacts");
const coverageDir = path.join(TEST_ARTIFACTS, "coverage", "browser");

interface BrowserCoverageFile {
  scripts: ScriptCoverage[];
}

interface ScriptCoverage {
  url: string;
  functions: {
    ranges: { startOffset: number; endOffset: number; count: number }[];
  }[];
}

const files = await readdir(coverageDir).catch(() => []);
const byScript = new Map<string, { functions: Map<string, boolean>; tests: number }>();

for (const file of files.filter((entry) => entry.endsWith(".json"))) {
  const parsed = JSON.parse(await readFile(path.join(coverageDir, file), "utf8")) as BrowserCoverageFile;
  for (const script of parsed.scripts ?? []) {
    const key = scriptKey(script.url);
    const entry = byScript.get(key) ?? { functions: new Map<string, boolean>(), tests: 0 };
    entry.tests += 1;
    for (const fn of script.functions) {
      const range = fn.ranges[0];
      if (!range) continue;
      const fnKey = `${range.startOffset}:${range.endOffset}`;
      entry.functions.set(fnKey, (entry.functions.get(fnKey) ?? false) || range.count > 0);
    }
    byScript.set(key, entry);
  }
}

if (byScript.size === 0) {
  console.log("Browser V8 coverage: no browser bundle coverage was collected.");
  process.exit(0);
}

console.log("Browser V8 function coverage:");
for (const [script, entry] of [...byScript.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const totalFunctions = entry.functions.size;
  const coveredFunctions = [...entry.functions.values()].filter(Boolean).length;
  const percent = totalFunctions === 0 ? 100 : (coveredFunctions / totalFunctions) * 100;
  console.log(
    `  ${script}: ${coveredFunctions}/${totalFunctions} functions (${percent.toFixed(2)}%) across ${entry.tests} tests`,
  );
}

function scriptKey(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
