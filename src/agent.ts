import fs from "node:fs";
import path from "node:path";
import {
  appendReply,
  applyAgentUpdate,
  createComment,
  deleteReply,
  readCommentState,
  readDocumentFileState,
  readDocumentState,
  resolveDocumentPath,
  resolveThread,
  type AgentUpdateInput,
  type CommentAnchor,
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

  if (commandName === "comments") {
    const documentPath = resolveRequiredDocument(argsForCommand[0]);
    printJson(readCommentState(documentPath));
    return;
  }

  if (commandName === "file") {
    const documentPath = resolveRequiredDocument(argsForCommand[0]);
    printJson(readDocumentFileState(documentPath));
    return;
  }

  if (commandName === "comment") {
    const [documentArg, quote, ...bodyParts] = argsForCommand;
    const documentPath = resolveRequiredDocument(documentArg);
    if (!quote) throw new Error("comment requires the exact quoted target text.");
    const withAuthor = takeAuthor(bodyParts, "AI");
    const withThreadId = takeOption(withAuthor.rest, "--thread-id");
    const threadId = normalizeThreadId(withThreadId.value);
    const withOccurrence = takeOption(withThreadId.rest, "--occurrence");
    const body = withOccurrence.rest.join(" ").trim();
    printJson(
      createComment(documentPath, {
        anchor: anchorForQuote(documentPath, quote, withOccurrence.value, threadId),
        quote,
        body,
        author: withAuthor.author,
        threadId,
      }),
    );
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

function takeOption(parts: string[], flag: string): { value: string | undefined; rest: string[] } {
  const flagIndex = parts.findIndex((part) => part === flag);
  if (flagIndex === -1) {
    return { value: undefined, rest: parts };
  }

  const value = parts[flagIndex + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }

  return {
    value,
    rest: [...parts.slice(0, flagIndex), ...parts.slice(flagIndex + 2)],
  };
}

function normalizeThreadId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const threadId = value.trim();
  if (!threadId.startsWith("thread_") || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) {
    throw new Error("--thread-id must match ^thread_[A-Za-z0-9_-]{1,128}$.");
  }
  return threadId;
}

function anchorForQuote(
  documentPath: string,
  quote: string,
  occurrenceValue: string | undefined,
  anchorId: string | undefined,
): CommentAnchor {
  const occurrence = normalizeOccurrence(occurrenceValue);
  const documentText = textContentForAnchoring(readDocumentState(documentPath).html);
  const matches = findQuoteOccurrences(documentText, quote);

  if (matches.length === 0) {
    throw new Error("Quoted text was not found in the document body.");
  }
  if (occurrence === undefined && matches.length > 1) {
    throw new Error(
      `Quoted text appears ${matches.length} times. Pass --occurrence N to choose the 1-based occurrence.`,
    );
  }
  if (occurrence !== undefined && occurrence > matches.length) {
    throw new Error(
      `Quoted text appears ${matches.length} times, but --occurrence ${occurrence} was requested.`,
    );
  }

  const selected = matches[(occurrence ?? 1) - 1];
  const anchor: CommentAnchor = {
    type: "text-range",
    quote,
    prefix: documentText.slice(Math.max(0, selected.start - 120), selected.start),
    suffix: documentText.slice(selected.end, selected.end + 120),
    textPosition: selected,
  };
  if (anchorId) anchor.anchorId = anchorId;
  return anchor;
}

function normalizeOccurrence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--occurrence must be a positive 1-based integer.");
  }
  return Number(value);
}

function findQuoteOccurrences(documentText: string, quote: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  let startAt = 0;
  while (startAt <= documentText.length) {
    const start = documentText.indexOf(quote, startAt);
    if (start === -1) break;
    matches.push({ start, end: start + quote.length });
    startAt = start + Math.max(quote.length, 1);
  }
  return matches;
}

function textContentForAnchoring(html: string): string {
  const withoutState = html.replace(
    /[ \t]*<script\b(?=[^>]*\bid\s*=\s*(["'])(?:redline-state|coauthor-state)\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>[ \t]*(?:\r?\n)?/gi,
    "",
  );
  const bodyMatch = withoutState.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? withoutState;
  return decodeHtmlEntities(
    bodyHtml
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  bun src/agent.ts comments <document.html>
  bun src/agent.ts file <document.html>
  bun src/agent.ts state <document.html>
  bun src/agent.ts comment <document.html> "<quoted text>" <message> [--occurrence N] [--author AI] [--thread-id thread_xyz]
  bun src/agent.ts reply <document.html> <thread-id> <message> [--author AI]
  bun src/agent.ts delete-reply <document.html> <thread-id> <message-id>
  bun src/agent.ts resolve <document.html> <thread-id>
  bun src/agent.ts apply <document.html> <payload.json>
  bun src/agent.ts update-html <document.html> <updated.html>

The apply payload may include:
  {
    "html": "<!doctype html>...",
    "comments": [{ "body": "...", "author": "AI", "anchor": { "type": "text-range", "quote": "..." } }],
    "replies": [{ "threadId": "...", "body": "...", "author": "AI" }],
    "resolveThreadIds": ["..."]
  }`);
}
