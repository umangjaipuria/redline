// A single adaptive poller for the active document — the pull-based replacement
// for the old SSE doorbell. It asks "did /state change?" on a cadence tuned to
// whether the tab is visible and recently used, and pauses entirely when the tab
// is hidden. Because a paused poll holds no connection, any number of background
// document tabs cost nothing — which is precisely what lets Redline keep many
// docs open at once without exhausting the browser's ~6-connections-per-origin
// budget (the wedge that persistent SSE streams caused).
//
// Liveness for the doc you're looking at comes from a short interval; sleep/wake
// and network blips self-correct because visibility/focus/online all force an
// immediate catch-up poll, and failures back off instead of hammering. Every
// request carries an AbortSignal with a hard timeout so a stalled fetch can never
// wedge the loop or hold a socket open — the exact failure mode this refactor
// exists to kill.

import type { DocumentStateResponse } from "../shared";
import { ApiError } from "./api";

export interface DocPollerOptions {
  // Fetch state conditionally on the version we last saw, honoring the signal.
  // Resolves to the fresh state, or null when the server answered 304 (unchanged).
  fetchState: (
    docId: string,
    knownVersion: string | undefined,
    signal: AbortSignal,
  ) => Promise<DocumentStateResponse | null>;
  getKnownVersion: () => string | undefined;
  onState: (next: DocumentStateResponse) => void;
  // The docId is gone (404): the server restarted (ids are ephemeral across
  // restarts) or the document was closed. The app re-resolves by path.
  onUnknownDoc: (docId: string) => void;
  onNetworkError?: (error: unknown) => void;
  onRecovered?: () => void;
}

const FOREGROUND_MS = 3_000;
const IDLE_MS = 15_000;
const IDLE_AFTER_MS = 60_000; // no interaction for this long → back off to IDLE_MS
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000; // a poll that outlasts this is aborted, never left hanging
const INTERACTION_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

export class DocPoller {
  private docId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Bumped whenever the target changes or we stop. A tick captures the generation
  // it started under and cancels itself if it no longer matches, so an in-flight
  // request for a doc we've navigated away from can never repaint or reschedule.
  private generation = 0;
  private backoffMs = 0;
  private lastInteractionAt = Date.now();
  // The generation whose request is currently in flight (null if none). Overlap is
  // prevented only *within* a generation; a new target is free to start at once
  // because setTarget aborts the superseded request.
  private inFlightGeneration: number | null = null;
  private activeController: AbortController | null = null;
  private disposed = false;

  constructor(private readonly opts: DocPollerOptions) {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onWake);
    window.addEventListener("online", this.onWake);
    for (const event of INTERACTION_EVENTS) {
      window.addEventListener(event, this.onInteraction, { passive: true });
    }
  }

  // Point the poller at a document and catch up immediately, releasing any request
  // still in flight for the previous target.
  setTarget(docId: string): void {
    this.docId = docId;
    this.generation += 1;
    this.backoffMs = 0;
    this.abortActive();
    this.pollNow();
  }

  // Stop polling (e.g. back to the chooser). Safe to call repeatedly.
  clearTarget(): void {
    this.docId = null;
    this.generation += 1;
    this.cancelTimer();
    this.abortActive();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTarget();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onWake);
    window.removeEventListener("online", this.onWake);
    for (const event of INTERACTION_EVENTS) {
      window.removeEventListener(event, this.onInteraction);
    }
  }

  pollNow(): void {
    if (this.disposed || !this.docId) return;
    this.cancelTimer();
    void this.tick(this.generation);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      this.onWake();
    } else {
      // Hidden: stop scheduling and release any in-flight connection immediately.
      // Advance the generation so the aborted request is fully superseded — otherwise
      // a fast re-show could call tick() while the aborted tick's `inFlightGeneration`
      // still matches, get skipped as "already in flight", and stall the loop forever.
      this.generation += 1;
      this.cancelTimer();
      this.abortActive();
    }
  };

  private onWake = (): void => {
    // Became visible / focused / back online: reset backoff and catch up now.
    this.backoffMs = 0;
    this.pollNow();
  };

  private onInteraction = (): void => {
    this.lastInteractionAt = Date.now();
  };

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private abortActive(): void {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
  }

  private schedule(generation: number): void {
    if (this.disposed || !this.docId || generation !== this.generation) return;
    if (document.visibilityState === "hidden") return; // paused; onVisibility resumes
    this.cancelTimer(); // exactly one pending timer at a time — never leak a chain
    const idle = Date.now() - this.lastInteractionAt > IDLE_AFTER_MS;
    const base = this.backoffMs > 0 ? this.backoffMs : idle ? IDLE_MS : FOREGROUND_MS;
    // ±15% jitter so many tabs waking together don't align into a poll burst.
    const delay = base * (0.85 + Math.random() * 0.3);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(generation);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || !this.docId) return;
    if (document.visibilityState === "hidden") return; // never poll a hidden tab
    if (this.inFlightGeneration === generation) return; // no overlap within a generation
    const docId = this.docId;
    this.inFlightGeneration = generation;
    const controller = new AbortController();
    this.activeController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const next = await this.opts.fetchState(docId, this.opts.getKnownVersion(), controller.signal);
      if (generation !== this.generation) return; // navigated away mid-flight
      if (this.backoffMs > 0) {
        this.backoffMs = 0;
        this.opts.onRecovered?.();
      }
      if (next) this.opts.onState(next);
      this.schedule(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ApiError && error.status === 404) {
        // Doc gone: stop this loop. The app re-resolves by path and re-targets us.
        this.opts.onUnknownDoc(docId);
        return;
      }
      if (isAbortError(error) && !timedOut) {
        // A deliberate abort (tab hidden, disposed, target changed). Not a failure;
        // don't back off and don't reschedule — the triggering path drives what's next.
        return;
      }
      // Timeout or genuine network failure: back off and keep trying.
      this.backoffMs = this.backoffMs > 0 ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
      this.opts.onNetworkError?.(error);
      this.schedule(generation);
    } finally {
      clearTimeout(timeout);
      if (this.inFlightGeneration === generation) this.inFlightGeneration = null;
      if (this.activeController === controller) this.activeController = null;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}
