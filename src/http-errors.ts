export interface ClientError {
  message: string;
  status: number;
}

export function clientErrorFor(error: unknown): ClientError | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;

  if (message === "Request body must be valid JSON.") {
    return { message, status: 400 };
  }
  if (message === "body is required.") {
    return { message, status: 400 };
  }
  if (message === "Comment body is required." || message === "Reply body is required.") {
    return { message, status: 400 };
  }
  if (message.startsWith("Quoted text ")) {
    return { message, status: 422 };
  }
  if (message === "threadId and anchor.anchorId must match for anchored comments.") {
    return { message, status: 422 };
  }
  if (message === "The original comment cannot be deleted as a reply.") {
    return { message, status: 422 };
  }
  if (message.startsWith("Comment thread already exists:")) {
    return { message, status: 409 };
  }
  if (
    message.startsWith("Comment thread not found:") ||
    message.startsWith("Comment message not found:") ||
    message.startsWith("Reply not found:")
  ) {
    return { message, status: 404 };
  }

  return undefined;
}
