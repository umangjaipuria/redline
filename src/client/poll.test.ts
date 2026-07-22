import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DocPoller, type DocPollerOptions } from "./poll";
import { ApiError } from "./api";
import type { DocumentStateResponse } from "../shared";

// Real globals, captured before we stub them, so tests can await a genuine
// macrotask to let the poller's async settle without firing its (stubbed) timers,
// and so afterEach can fully restore the environment.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDocument = (globalThis as unknown as { document: unknown }).document;
const realWindow = (globalThis as unknown as { window: unknown }).window;
const flush = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

// --- minimal DOM stubs ----------------------------------------------------

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

class FakeDocument extends FakeEventTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

// --- fake timers (capture scheduled callbacks without firing them) --------

interface FakeTimer {
  id: number;
  fn: () => void;
  delay: number;
}
let timers: FakeTimer[] = [];
let nextTimerId = 1;

function fireTimersWithDelay(predicate: (delay: number) => boolean): void {
  const due = timers.filter((t) => predicate(t.delay));
  timers = timers.filter((t) => !predicate(t.delay));
  for (const t of due) t.fn();
}

let fakeDocument: FakeDocument;
let fakeWindow: FakeEventTarget;

function stateFixture(overrides: Partial<DocumentStateResponse> = {}): DocumentStateResponse {
  return {
    docId: "doc_a",
    path: "/tmp/a.html",
    format: "html",
    version: "v1",
    startedAt: "boot",
    updatedAt: "now",
    renderedHtml: "<p>a</p>",
    threads: [],
    anchors: [],
    summary: { threads: 0, messages: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fakeDocument = new FakeDocument();
  fakeWindow = new FakeEventTarget();
  (globalThis as unknown as { document: unknown }).document = fakeDocument;
  (globalThis as unknown as { window: unknown }).window = fakeWindow;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, delay: number) => {
    const id = nextTimerId++;
    timers.push({ id, fn, delay });
    return id;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
    timers = timers.filter((t) => t.id !== id);
  }) as typeof clearTimeout;
});

afterEach(() => {
  timers = [];
  nextTimerId = 1;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
  (globalThis as unknown as { document: unknown }).document = realDocument;
  (globalThis as unknown as { window: unknown }).window = realWindow;
});

type Respond = DocPollerOptions["fetchState"];

// `respond` provides the fetch behavior; makePoller always records the call args
// first (so overriding behavior can't drop the capture). Default: a 304 (null).
function makePoller(respond?: Respond): {
  poller: DocPoller;
  calls: { onState: DocumentStateResponse[]; unknown: string[]; recovered: number; networkError: number };
  fetchArgs: { docId: string; knownVersion: string | undefined; signal: AbortSignal }[];
} {
  const calls = { onState: [] as DocumentStateResponse[], unknown: [] as string[], recovered: 0, networkError: 0 };
  const fetchArgs: { docId: string; knownVersion: string | undefined; signal: AbortSignal }[] = [];
  const poller = new DocPoller({
    fetchState: (docId, knownVersion, signal) => {
      fetchArgs.push({ docId, knownVersion, signal });
      return respond ? respond(docId, knownVersion, signal) : Promise.resolve(null);
    },
    getKnownVersion: () => undefined,
    onState: (next) => calls.onState.push(next),
    onUnknownDoc: (id) => calls.unknown.push(id),
    onRecovered: () => (calls.recovered += 1),
    onNetworkError: () => (calls.networkError += 1),
  });
  return { poller, calls, fetchArgs };
}

describe("DocPoller", () => {
  test("polls immediately on setTarget and repaints on fresh state", async () => {
    const d = deferred<DocumentStateResponse | null>();
    const { poller, calls, fetchArgs } = makePoller(() => d.promise);
    poller.setTarget("doc_a");
    expect(fetchArgs).toHaveLength(1);
    expect(fetchArgs[0]!.docId).toBe("doc_a");

    d.resolve(stateFixture());
    await flush();
    expect(calls.onState).toHaveLength(1);
    // Exactly one pending timer remains (the next poll) — no leaked chain, and the
    // request-timeout was cleared on completion.
    expect(timers).toHaveLength(1);
    poller.dispose();
  });

  test("a 304 (null) refreshes nothing but keeps polling", async () => {
    const { poller, calls } = makePoller();
    poller.setTarget("doc_a");
    await flush();
    expect(calls.onState).toHaveLength(0);
    expect(timers).toHaveLength(1); // rescheduled
    poller.dispose();
  });

  test("a wake while a request is in flight does not start a second request", async () => {
    const d = deferred<DocumentStateResponse | null>();
    const { poller, fetchArgs } = makePoller(() => d.promise);
    poller.setTarget("doc_a");
    expect(fetchArgs).toHaveLength(1);
    fakeWindow.dispatch("focus"); // onWake → pollNow, but a request is already in flight
    fakeWindow.dispatch("focus");
    expect(fetchArgs).toHaveLength(1); // still one — no overlap
    poller.dispose();
  });

  test("changing target aborts the in-flight request and adopts only the new one", async () => {
    const first = deferred<DocumentStateResponse | null>();
    const second = deferred<DocumentStateResponse | null>();
    const queue = [first, second];
    const { poller, calls, fetchArgs } = makePoller(() => queue.shift()!.promise);

    poller.setTarget("doc_a");
    const signalA = fetchArgs[0]!.signal;
    poller.setTarget("doc_b");
    expect(signalA.aborted).toBe(true); // old request released
    expect(fetchArgs[1]!.docId).toBe("doc_b");

    first.resolve(stateFixture({ docId: "doc_a" })); // late resolve of the abandoned request
    second.resolve(stateFixture({ docId: "doc_b" }));
    await flush();
    expect(calls.onState.map((s) => s.docId)).toEqual(["doc_b"]); // never repainted doc_a
    poller.dispose();
  });

  test("a 404 reports the doc gone and stops the loop", async () => {
    const { poller, calls } = makePoller(async () => {
      throw new ApiError("gone", 404);
    });
    poller.setTarget("doc_a");
    await flush();
    expect(calls.unknown).toEqual(["doc_a"]);
    expect(timers).toHaveLength(0); // no reschedule after a 404
    poller.dispose();
  });

  test("a network error backs off, then recovers on the next success", async () => {
    let attempt = 0;
    const { poller, calls } = makePoller(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return stateFixture();
    });
    poller.setTarget("doc_a");
    await flush();
    expect(calls.networkError).toBe(1);
    expect(timers).toHaveLength(1); // rescheduled with backoff

    fireTimersWithDelay(() => true); // fire the backoff retry
    await flush();
    expect(calls.recovered).toBe(1);
    poller.dispose();
  });

  test("a stalled request is aborted by the timeout and retried", async () => {
    const { poller, calls, fetchArgs } = makePoller(
      (_id, _v, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    poller.setTarget("doc_a");
    expect(fetchArgs).toHaveLength(1);
    // Fire the 12s request-timeout; the abort rejects the stalled fetch.
    fireTimersWithDelay((delay) => delay >= 12_000);
    await flush();
    expect(calls.networkError).toBe(1); // treated as a failure → backoff, not silently stuck
    expect(timers.length).toBeGreaterThanOrEqual(1); // rescheduled, loop not wedged
    poller.dispose();
  });

  test("a hidden tab does not poll; becoming visible catches up", async () => {
    const { poller, fetchArgs } = makePoller();
    fakeDocument.visibilityState = "hidden";
    poller.setTarget("doc_a");
    await flush();
    expect(fetchArgs).toHaveLength(0); // paused while hidden

    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatch("visibilitychange");
    await flush();
    expect(fetchArgs).toHaveLength(1); // caught up on becoming visible
    poller.dispose();
  });

  test("dispose removes every listener and aborts the in-flight request", async () => {
    const d = deferred<DocumentStateResponse | null>();
    const { poller, fetchArgs } = makePoller(() => d.promise);
    poller.setTarget("doc_a");
    const signal = fetchArgs[0]!.signal;
    expect(fakeDocument.listenerCount() + fakeWindow.listenerCount()).toBeGreaterThan(0);

    poller.dispose();
    expect(signal.aborted).toBe(true);
    expect(fakeDocument.listenerCount()).toBe(0);
    expect(fakeWindow.listenerCount()).toBe(0);
  });

  test("hide during an in-flight request then an immediate show keeps polling (no stall)", async () => {
    const { poller, calls, fetchArgs } = makePoller(
      (_id, _v, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    poller.setTarget("doc_a");
    expect(fetchArgs).toHaveLength(1);
    const firstSignal = fetchArgs[0]!.signal;

    fakeDocument.visibilityState = "hidden";
    fakeDocument.dispatch("visibilitychange"); // aborts the in-flight request
    expect(firstSignal.aborted).toBe(true);
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatch("visibilitychange"); // immediately shown again
    await flush();

    // The loop must have resumed with a fresh request — this is the stall the
    // generation-bump-on-hide fix prevents — and the deliberate abort is not a failure.
    expect(fetchArgs.length).toBeGreaterThanOrEqual(2);
    expect(calls.networkError).toBe(0);
    poller.dispose();
  });

  test("clearTarget during an in-flight request aborts it and stops the loop", async () => {
    const d = deferred<DocumentStateResponse | null>();
    const { poller, calls, fetchArgs } = makePoller(() => d.promise);
    poller.setTarget("doc_a");
    const signal = fetchArgs[0]!.signal;

    poller.clearTarget();
    expect(signal.aborted).toBe(true);
    d.resolve(stateFixture()); // late resolve of the abandoned request
    await flush();
    expect(calls.onState).toHaveLength(0); // never repainted after clearTarget
    expect(timers).toHaveLength(0); // no reschedule
    poller.dispose();
  });

  test("a wake while the next poll is merely scheduled fires it now, without duplicating timers", async () => {
    const { poller, fetchArgs } = makePoller(); // default: 304
    poller.setTarget("doc_a");
    await flush();
    expect(fetchArgs).toHaveLength(1);
    expect(timers).toHaveLength(1); // next poll scheduled

    fakeWindow.dispatch("focus"); // wake while a timer is pending
    await flush();
    expect(fetchArgs).toHaveLength(2); // fired immediately
    expect(timers).toHaveLength(1); // still exactly one pending timer — no leaked chain
    poller.dispose();
  });
});
