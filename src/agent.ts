import fs from "node:fs";
import path from "node:path";
import {
  appendReply,
  applyAgentUpdate,
  deleteReply,
  readDocumentState,
  resolveDocumentPath,
  resolveThread,
  type AgentUpdateInput,
} from "./state";

const [command, ...args] = Bun.argv.slice(2);

try {
  run(command, args);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown agent command error.";
  console.error(message);
  process.exit(1);
}

function run(commandName: string | undefined, argsForCommand: string[]): void {
  if (!commandName || commandName === "-h" || commandName === "--help") {
    printHelp();
    return;
  }

  if (commandName === "state") {
    const documentPath = resolveRequiredDocument(argsForCommand[0]);
    printJson(readDocumentState(documentPath));
    return;
  }

  if (commandName === "reply") {
    const [documentArg, threadId, ...messageParts] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!threadId) throw new Error("reply requires a thread id.");
    const { author, rest } = takeAuthor(messageParts, "AI");
    const body = rest.join(" ").trim();
    printJson(appendReply(documentPath, threadId, body, author));
    return;
  }

  if (commandName === "resolve") {
    const [documentArg, threadId] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!threadId) throw new Error("resolve requires a thread id.");
    printJson(resolveThread(documentPath, threadId));
    return;
  }

  if (commandName === "delete-reply") {
    const [documentArg, threadId, messageId] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!threadId) throw new Error("delete-reply requires a thread id.");
    if (!messageId) throw new Error("delete-reply requires a message id.");
    printJson(deleteReply(documentPath, threadId, messageId));
    return;
  }

  if (commandName === "apply") {
    const [documentArg, payloadPath] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!payloadPath) throw new Error("apply requires a JSON payload file.");
    const payload = JSON.parse(fs.readFileSync(path.resolve(payloadPath), "utf8")) as AgentUpdateInput;
    printJson(applyAgentUpdate(documentPath, payload));
    return;
  }

  if (commandName === "update-html") {
    const [documentArg, htmlPath] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!htmlPath) throw new Error("update-html requires an HTML file.");
    const html = fs.readFileSync(path.resolve(htmlPath), "utf8");
    printJson(applyAgentUpdate(documentPath, { html }));
    return;
  }

  throw new Error(`Unknown command: ${commandName}`);
}

function resolveRequiredDocument(input: string | undefined): string {
  if (!input) throw new Error("A document path is required.");
  return resolveDocumentPath(input);
}

function takeAuthor(parts: string[], fallback: string): { author: string; rest: string[] } {
  const authorIndex = parts.findIndex((part) => part === "--author");
  if (authorIndex === -1) {
    return { author: fallback, rest: parts };
  }

  const author = parts[authorIndex + 1];
  if (!author) {
    throw new Error("--author requires a value.");
  }

  return {
    author,
    rest: [...parts.slice(0, authorIndex), ...parts.slice(authorIndex + 2)],
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  bun src/agent.ts state <document.html>
  bun src/agent.ts reply <document.html> <thread-id> <message> [--author AI]
  bun src/agent.ts delete-reply <document.html> <thread-id> <message-id>
  bun src/agent.ts resolve <document.html> <thread-id>
  bun src/agent.ts apply <document.html> <payload.json>
  bun src/agent.ts update-html <document.html> <updated.html>

The apply payload may include:
  {
    "html": "<!doctype html>...",
    "comments": [{ "body": "...", "author": "AI", "anchor": { "type": "document" } }],
    "replies": [{ "threadId": "...", "body": "...", "author": "AI" }],
    "resolveThreadIds": ["..."]
  }`);
}
