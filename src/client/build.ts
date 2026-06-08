// Build the Preact client to dist/ with Bun's built-in bundler. The server runs
// TypeScript directly (no build); only the browser client needs bundling.
// dist/ is gitignored and served as an external asset directory.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = __dirname;
const distDir = path.resolve(__dirname, "../../dist");

export async function buildClient(options: { minify?: boolean } = {}): Promise<void> {
  fs.mkdirSync(distDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [path.join(clientDir, "main.tsx")],
    outdir: distDir,
    minify: options.minify ?? true,
    target: "browser",
    naming: "[name].[ext]",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Client build failed.");
  }

  // Static shell + styles ship alongside the bundle.
  fs.copyFileSync(path.join(clientDir, "index.html"), path.join(distDir, "index.html"));
  fs.copyFileSync(path.join(clientDir, "style.css"), path.join(distDir, "style.css"));

  console.log(`Built client → ${distDir}`);
}

if (import.meta.main) {
  buildClient({ minify: !Bun.argv.includes("--no-minify") }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
