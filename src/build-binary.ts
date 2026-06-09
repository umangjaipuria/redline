// Build a standalone Redline executable. The normal server can build/serve the
// client from disk; the compiled binary needs those files embedded up front.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./client/build";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scratchDir = path.join(repoRoot, ".test-artifacts", "binary-build");
const entryPath = path.join(scratchDir, "entry.ts");
const distDir = path.join(repoRoot, "dist");
const publicDir = path.join(repoRoot, "public");
const outfile = path.join(repoRoot, "redline");

type Asset = {
  file: string;
  route: string;
};

async function main(): Promise<void> {
  await buildClient();
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });

  const assets = [
    ...collectFiles(distDir).map((file) => ({ file, route: webPath(path.relative(distDir, file)) })),
    ...collectFiles(publicDir).map((file) => ({ file, route: webPath(path.relative(publicDir, file)) })),
  ];
  writeEntry(assets);

  const proc = Bun.spawn({
    cmd: [process.execPath, "build", "--compile", "--minify", "--outfile", outfile, entryPath],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Binary build failed.");
  }

  console.log(`Built binary -> ${outfile}`);
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files.sort();
}

function writeEntry(assets: Asset[]): void {
  const serverImport = importPath(path.relative(scratchDir, path.join(repoRoot, "src/server/server.ts")));
  const imports = assets
    .map((asset, index) => `import asset${index} from ${JSON.stringify(importPath(path.relative(scratchDir, asset.file)))} with { type: "file" };`)
    .join("\n");
  const manifest = assets
    .map((asset, index) => `  { route: ${JSON.stringify(asset.route)}, file: Bun.file(asset${index}) },`)
    .join("\n");

  fs.writeFileSync(
    entryPath,
    [
      `import { runServerCli, setEmbeddedStaticAssets } from ${JSON.stringify(serverImport)};`,
      imports,
      "",
      "setEmbeddedStaticAssets([",
      manifest,
      "]);",
      "",
      "await runServerCli(Bun.argv.slice(2));",
      "",
    ].join("\n"),
    "utf8",
  );
}

function webPath(relativePath: string): string {
  return `/${relativePath.split(path.sep).join("/")}`;
}

function importPath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
