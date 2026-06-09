import { expect, test as base, type BrowserContext, type Frame, type Page, type TestInfo } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TEST_ARTIFACTS = process.env.REDLINE_TEST_ARTIFACTS ?? path.join(ROOT, ".test-artifacts");
const BROWSER_COVERAGE_DIR = path.join(TEST_ARTIFACTS, "coverage", "browser");
const STARTED_AT = "2026-01-01T00:00:00.000Z";

interface RedlineInstance {
  origin: string;
  docId: string;
  filePath: string;
  stop: () => Promise<void>;
}

const test = base.extend<{ browserCoverage: void }>({
  browserCoverage: [
    async ({ browserName, context, page }, use, testInfo) => {
      const recorder = await startBrowserCoverage(browserName, context, page);
      try {
        await use();
      } finally {
        await recorder?.stop(testInfo);
      }
    },
    { auto: true },
  ],
});

test.beforeAll(async () => {
  if (process.env.REDLINE_BROWSER_COVERAGE === "1") {
    await rm(BROWSER_COVERAGE_DIR, { recursive: true, force: true });
  }
});

test("paints embedded anchors and activates the matching rail card from an iframe highlight", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>Intro text before unique highlight target continues after for the browser.</p>
          <p>Extra paragraph so the rendered document has normal flow.</p>
        </main>
      `,
      threads: [threadFixture({
        id: "thread_existing",
        body: "Existing anchored note",
        quote: "unique highlight target",
        prefix: "Intro text before ",
        suffix: " continues after",
        posStart: 18,
        posEnd: 41,
      })],
    }),
  );
  try {
    const frame = await openDocument(page, app);
    const highlight = frame.locator('.redline-highlight[data-thread-id="thread_existing"]');

    await expect(highlight).toBeVisible();
    await expect(page.locator('.thread-card[data-thread-id="thread_existing"]')).toContainText("Existing anchored note");

    await highlight.click();

    await expect(page.locator('.thread-card[data-thread-id="thread_existing"]')).toHaveClass(/active/);
    await expect(highlight).toHaveClass(/active/);
  } finally {
    await app.stop();
  }
});

test("creates a persisted comment from a real iframe text selection", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p id="comment-source">Select this exact phrase to make a browser comment.</p>
        </main>
      `,
    }),
  );
  try {
    const frame = await openDocument(page, app);
    await selectText(frame, "exact phrase");

    await page.getByLabel("Comment on selection").click();
    await page.locator(".composer textarea").fill("Browser selection works");
    await page.getByLabel("Post comment").click();

    await expect(page.locator(".thread-card")).toContainText("Browser selection works");
    const saved = await readFile(app.filePath, "utf8");
    expect(saved).toContain('id="redline-state"');
    expect(saved).toContain("Browser selection works");
    expect(saved).toContain("exact phrase");
    expect(saved).not.toContain("data-redline-anchor");
  } finally {
    await app.stop();
  }
});

test("updates the open browser when another client writes a comment through the API", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>The live update phrase should receive a comment while the browser is open.</p>
        </main>
      `,
    }),
  );
  try {
    const frame = await openDocument(page, app);
    await expect(frame.locator("body")).toContainText("live update phrase");

    const response = await fetch(`${app.origin}/api/docs/${app.docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Arrived over SSE",
        author: "Codex",
        quote: "live update phrase",
      }),
    });
    expect(response.ok).toBe(true);

    await expect(page.locator(".thread-card")).toContainText("Arrived over SSE");
    await expect(frame.locator(".redline-highlight")).toContainText("live update phrase");
  } finally {
    await app.stop();
  }
});

test("shows orphaned state after an external document edit removes the anchored text", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>Before the edit, soon deleted phrase appears here.</p>
        </main>
      `,
      threads: [threadFixture({
        id: "thread_orphan_check",
        body: "Watch this anchor through an external edit",
        quote: "soon deleted phrase",
        prefix: "Before the edit, ",
        suffix: " appears here.",
        posStart: 17,
        posEnd: 36,
      })],
    }),
  );
  try {
    const frame = await openDocument(page, app);
    await expect(frame.locator('.redline-highlight[data-thread-id="thread_orphan_check"]')).toBeVisible();

    const before = await readFile(app.filePath, "utf8");
    await writeFile(
      app.filePath,
      before.replace("soon deleted phrase appears here.", "a completely rewritten passage appears here."),
      "utf8",
    );

    const card = page.locator('.thread-card[data-thread-id="thread_orphan_check"]');
    await expect(card).toContainText("Orphaned", { timeout: 8_000 });
    await expect(card).toHaveClass(/unanchored/);
  } finally {
    await app.stop();
  }
});

test("passive browser reconcile does not rewrite the file after an external edit", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>Opening words before stable phrase continues after.</p>
        </main>
      `,
      threads: [threadFixture({
        id: "thread_passive_reconcile",
        body: "This should stay anchored without a background write",
        quote: "stable phrase",
        prefix: "Opening words before ",
        suffix: " continues after.",
        posStart: 21,
        posEnd: 34,
      })],
    }),
  );
  try {
    const frame = await openDocument(page, app);
    await expect(frame.locator('.redline-highlight[data-thread-id="thread_passive_reconcile"]')).toBeVisible();

    const before = await readFile(app.filePath, "utf8");
    const edited = before.replace("Opening words before stable phrase", "Opening words before a stable phrase");
    await writeFile(app.filePath, edited, "utf8");

    await expect(page.locator(".banner.notice")).toContainText("Document changed on disk", { timeout: 8_000 });
    await expect(frame.locator('.redline-highlight[data-thread-id="thread_passive_reconcile"]')).toBeVisible();
    expect(await readFile(app.filePath, "utf8")).toBe(edited);
  } finally {
    await app.stop();
  }
});

test("keeps the comment rail synced while the reviewed iframe document scrolls", async ({ page }) => {
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>Top of the document.</p>
          <div style="height: 1300px;"></div>
          <p>Near the bottom, rail sync target text sits here.</p>
          <div style="height: 700px;"></div>
        </main>
      `,
      threads: [threadFixture({
        id: "thread_scroll_sync",
        body: "Comment near the bottom",
        quote: "rail sync target text",
        prefix: "Near the bottom, ",
        suffix: " sits here.",
        posStart: 36,
        posEnd: 57,
      })],
    }),
  );
  try {
    const frame = await openDocument(page, app);
    const rail = page.locator(".comment-rail");
    await expect(page.locator('.thread-card[data-thread-id="thread_scroll_sync"]')).toBeVisible();

    const initialRailScroll = await rail.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(initialRailScroll).toBe(0);

    await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    await expect.poll(
      async () => rail.evaluate((el) => Math.round((el as HTMLElement).scrollTop)),
      { timeout: 5_000 },
    ).toBeGreaterThan(100);
  } finally {
    await app.stop();
  }
});

test("keeps the active rail card visible in dense comment clusters", async ({ page }) => {
  const denseThreads = Array.from({ length: 8 }, (_, index) => threadFixture({
    id: `thread_dense_${index}`,
    body: `Dense cluster comment ${index}. ${"This reply has enough text to make the card tall. ".repeat(8)}`,
    quote: `dense anchor ${index}`,
    prefix: `Cluster lead ${index}. `,
    suffix: ` continues after ${index}.`,
    posStart: 200 + index * 32,
    posEnd: 214 + index * 32,
  }));
  const app = await startRedline(
    page,
    htmlFixture({
      body: `
        <main>
          <p>Top of the document.</p>
          <div style="height: 1100px;"></div>
          ${Array.from({ length: 8 }, (_, index) =>
            `<p>Cluster lead ${index}. dense anchor ${index} continues after ${index}.</p>`,
          ).join("\n")}
          <div style="height: 900px;"></div>
        </main>
      `,
      threads: denseThreads,
    }),
  );
  try {
    const frame = await openDocument(page, app);
    const targetId = "thread_dense_5";
    const highlight = frame.locator(`.redline-highlight[data-thread-id="${targetId}"]`);
    const card = page.locator(`.thread-card[data-thread-id="${targetId}"]`);

    await highlight.scrollIntoViewIfNeeded();
    await highlight.click();
    await expect(card).toHaveClass(/active/);
    await expect.poll(() => railCardTopIsVisible(page, targetId), { timeout: 5_000 }).toBe(true);

    await page.locator(".comment-rail").evaluate((el) => { (el as HTMLElement).scrollTop = 0; });
    await card.click();
    await expect.poll(() => railCardTopIsVisible(page, targetId), { timeout: 5_000 }).toBe(true);
    await page.waitForTimeout(450);
    await expect.poll(() => railCardTopIsVisible(page, targetId), { timeout: 5_000 }).toBe(true);
  } finally {
    await app.stop();
  }
});

async function startRedline(page: Page, html: string): Promise<RedlineInstance> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "redline-browser-"));
  const homeDir = path.join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });
  const filePath = path.join(tempDir, "doc.html");
  await writeFile(filePath, html, "utf8");

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn("bun", ["src/server/server.ts", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, HOME: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureLogs(server);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await stopServer(server);
    await rm(tempDir, { recursive: true, force: true });
  };

  try {
    await waitForHealth(origin, server, logs);
    const response = await fetch(`${origin}/api/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    if (!response.ok) {
      throw new Error(`Could not open fixture document: ${response.status} ${await response.text()}`);
    }
    const info = (await response.json()) as { docId?: string };
    if (!info.docId) throw new Error("Redline did not return a docId.");

    return { origin, docId: info.docId, filePath, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function railCardTopIsVisible(page: Page, threadId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const rail = document.querySelector(".comment-rail");
    const card = document.querySelector(`.thread-card[data-thread-id="${id}"]`);
    if (!(rail instanceof HTMLElement) || !(card instanceof HTMLElement)) return false;
    const railRect = rail.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return cardRect.top >= railRect.top - 1 && cardRect.top <= railRect.bottom - 1;
  }, threadId);
}

async function openDocument(page: Page, app: RedlineInstance): Promise<Frame> {
  await page.goto(`${app.origin}/?doc=${app.docId}`);
  await expect(page.locator("iframe.document-frame")).toBeVisible();
  await expect(page.locator(".document-name")).toHaveText("doc.html");
  const frame = await documentFrame(page);
  await frame.locator("body").waitFor();
  return frame;
}

async function documentFrame(page: Page): Promise<Frame> {
  const handle = await page.locator("iframe.document-frame").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("Could not access the reviewed document iframe.");
  return frame;
}

async function selectText(frame: Frame, text: string): Promise<void> {
  await frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      const at = node.data.indexOf(needle);
      if (at !== -1) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      node = walker.nextNode() as Text | null;
    }
    throw new Error(`Could not find selectable text: ${needle}`);
  }, text);
}

function htmlFixture(options: { body: string; threads?: unknown[] }): string {
  const state = options.threads?.length
    ? `<script type="application/json" id="redline-state">${jsonForHtmlScript({
        schemaVersion: 2,
        updatedAt: STARTED_AT,
        threads: options.threads,
      })}</script>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Browser Fixture</title>
    ${state}
    <style>
      body { font: 16px/1.55 system-ui, sans-serif; margin: 48px; color: #1f2328; }
      main { max-width: 720px; }
    </style>
  </head>
  <body>
    ${options.body}
  </body>
</html>`;
}

function threadFixture(options: {
  id: string;
  body: string;
  quote: string;
  prefix: string;
  suffix: string;
  posStart: number;
  posEnd: number;
}): unknown {
  return {
    id: options.id,
    author: "Reviewer",
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    messages: [
      {
        id: `message_${options.id.replace(/^thread_/, "")}`,
        author: "Reviewer",
        body: options.body,
        createdAt: STARTED_AT,
      },
    ],
    anchor: {
      quote: options.quote,
      prefix: options.prefix,
      suffix: options.suffix,
      posStart: options.posStart,
      posEnd: options.posEnd,
    },
  };
}

function jsonForHtmlScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function captureLogs(server: ChildProcessWithoutNullStreams): () => string {
  let out = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => { out += chunk; });
  server.stderr.on("data", (chunk) => { out += chunk; });
  return () => out.trim();
}

async function waitForHealth(
  origin: string,
  server: ChildProcessWithoutNullStreams,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  server.once("exit", (code, signal) => { exit = { code, signal }; });

  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(`Redline server exited before becoming healthy: ${JSON.stringify(exit)}\n${logs()}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still binding.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Redline at ${origin}\n${logs()}`);
}

async function stopServer(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(2_000).then(() => {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startBrowserCoverage(
  browserName: string,
  context: BrowserContext,
  page: Page,
): Promise<{ stop: (testInfo: TestInfo) => Promise<void> } | null> {
  if (process.env.REDLINE_BROWSER_COVERAGE !== "1" || browserName !== "chromium") return null;

  const client = await context.newCDPSession(page);
  await client.send("Profiler.enable");
  await client.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

  return {
    stop: async (testInfo) => {
      const coverage = await client.send("Profiler.takePreciseCoverage");
      await client.send("Profiler.stopPreciseCoverage").catch(() => {});
      await client.send("Profiler.disable").catch(() => {});

      const scripts = coverage.result.filter((script: { url: string }) => script.url.includes("/main.js"));
      const summary = scripts.map((script: ScriptCoverage) => summarizeScriptCoverage(script));
      await mkdir(BROWSER_COVERAGE_DIR, { recursive: true });
      const name = testInfo.titlePath.join(" ").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
      await writeFile(
        path.join(BROWSER_COVERAGE_DIR, `${name}.json`),
        `${JSON.stringify({ title: testInfo.title, summary, scripts }, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

interface ScriptCoverage {
  url: string;
  functions: {
    ranges: { startOffset: number; endOffset: number; count: number }[];
  }[];
}

function summarizeScriptCoverage(script: ScriptCoverage): {
  url: string;
  totalFunctions: number;
  coveredFunctions: number;
  percent: number;
} {
  const totalFunctions = script.functions.length;
  const coveredFunctions = script.functions.filter((fn) => (fn.ranges[0]?.count ?? 0) > 0).length;
  return {
    url: script.url,
    totalFunctions,
    coveredFunctions,
    percent: totalFunctions === 0 ? 100 : Math.round((coveredFunctions / totalFunctions) * 10_000) / 100,
  };
}
