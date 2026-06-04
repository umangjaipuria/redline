import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const agentPath = path.join(projectRoot, "src", "agent.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDocument(html = "<!doctype html><html><body><p>Hello world.</p></body></html>") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-agent-"));
  tempDirs.push(dir);
  const documentPath = path.join(dir, "draft.html");
  fs.writeFileSync(documentPath, html);
  return documentPath;
}

test("comment helper rejects invalid explicit thread ids", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      agentPath,
      "comment",
      tempDocument(),
      "Hello world.",
      "Needs a note.",
      "--thread-id",
      "custom_bad_id",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain(
    "--thread-id must match ^thread_[A-Za-z0-9_-]{1,128}$.",
  );
});

test("comment helper accepts valid explicit thread ids", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      agentPath,
      "comment",
      tempDocument(),
      "Hello world.",
      "Needs a note.",
      "--thread-id",
      "thread_custom_id",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await proc.exited).toBe(0);
  const payload = await new Response(proc.stdout).json();
  expect(payload.threads[0]?.id).toBe("thread_custom_id");
  expect(payload.threads[0]?.anchor.anchorId).toBe("thread_custom_id");
  expect(payload.threads[0]?.anchor.textPosition).toEqual({ start: 0, end: 12 });
});

test("comment helper rejects ambiguous quoted text without an occurrence", async () => {
  const documentPath = tempDocument(
    "<!doctype html><html><body><p>Hello world.</p><p>Hello world.</p></body></html>",
  );
  const proc = Bun.spawn(
    [
      "bun",
      agentPath,
      "comment",
      documentPath,
      "Hello world.",
      "Needs a note.",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain(
    "Quoted text appears 2 times. Pass --occurrence N to choose the 1-based occurrence.",
  );
});

test("comment helper can anchor a selected repeated occurrence", async () => {
  const documentPath = tempDocument(
    "<!doctype html><html><body><p>Hello world.</p><p>Hello world.</p></body></html>",
  );
  const proc = Bun.spawn(
    [
      "bun",
      agentPath,
      "comment",
      documentPath,
      "Hello world.",
      "Second note.",
      "--occurrence",
      "2",
      "--thread-id",
      "thread_second_match",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await proc.exited).toBe(0);
  const payload = await new Response(proc.stdout).json();
  expect(payload.threads[0]?.id).toBe("thread_second_match");
  expect(payload.threads[0]?.anchor.anchorId).toBe("thread_second_match");
  expect(payload.threads[0]?.anchor.textPosition).toEqual({ start: 12, end: 24 });
  expect(payload.threads[0]?.anchor.prefix).toBe("Hello world.");
  expect(payload.threads[0]?.messages[0]?.body).toBe("Second note.");
});

test("edit-comment helper updates an existing comment message", async () => {
  const documentPath = tempDocument();
  const createProc = Bun.spawn(
    [
      "bun",
      agentPath,
      "comment",
      documentPath,
      "Hello world.",
      "Needs a note.",
      "--thread-id",
      "thread_edit_cli",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await createProc.exited).toBe(0);
  const created = await new Response(createProc.stdout).json();
  const messageId = String(created.threads[0]?.messages[0]?.id ?? "");

  const editProc = Bun.spawn(
    [
      "bun",
      agentPath,
      "edit-comment",
      documentPath,
      "thread_edit_cli",
      messageId,
      "Edited note.",
    ],
    {
      cwd: projectRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  expect(await editProc.exited).toBe(0);
  const edited = await new Response(editProc.stdout).json();
  expect(edited.threads[0]?.messages[0]?.body).toBe("Edited note.");
});
