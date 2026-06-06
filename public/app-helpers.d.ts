interface RailThreadLike {
  id: string;
  createdAt?: string;
  anchor?: {
    textPosition?: {
      start?: number | null;
    } | null;
  } | null;
}

interface AnchorElementLike {
  getAttribute(name: string): string | null;
}

interface DetailsElementLike {
  readonly parentElement: DetailsElementLike | null;
  readonly tagName: string;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

interface QueryRootLike<TElement> {
  querySelectorAll(selector: string): Iterable<TElement>;
}

export const MISSING_THREAD_ORDER: number;

export interface AlignedRailItemTopInput {
  edgePadding?: number;
  itemHeight?: number;
  railScrollTop?: number;
  railViewportHeight?: number;
  railViewportTop?: number;
  targetViewportTop?: number;
}

export function alignedRailItemTop(input?: AlignedRailItemTopInput): number;

export interface StackedRailItemLayoutItem {
  id: string;
  height?: number;
  targetViewportTop?: number | null;
}

export interface StackedRailItemLayoutInput {
  activeId?: string | null;
  edgePadding?: number;
  gap?: number;
  items?: readonly StackedRailItemLayoutItem[] | null;
  railScrollTop?: number;
  railViewportHeight?: number;
  railViewportTop?: number;
}

export interface StackedRailItemLayoutResult {
  contentHeight: number;
  positions: Map<string, number>;
}

export function stackedRailItemLayout(input?: StackedRailItemLayoutInput): StackedRailItemLayoutResult;

export function sortThreadsForRail<TThread extends RailThreadLike>(
  threads?: readonly TThread[] | null,
  liveOrder?: ReadonlyMap<string, number>,
): TThread[];

export function collectThreadLiveOrderFromAnchors(
  root?: QueryRootLike<AnchorElementLike> | null,
): Map<string, number>;

export interface CommentNavigationState {
  hasComments: boolean;
  nextDisabled: boolean;
  previousDisabled: boolean;
}

export function commentNavigationState(
  orderedIds?: readonly string[] | null,
  activeId?: string | null,
): CommentNavigationState;

export function commentNavigationTarget(
  orderedIds?: readonly string[] | null,
  activeId?: string | null,
  direction?: "previous" | "next",
): string | null;

export function openAncestorDetails(element?: DetailsElementLike | null): void;

export function removeRuntimeOpenedDetails(root?: QueryRootLike<DetailsElementLike> | null): void;

export interface ProgrammaticScrollGuardOptions<TTimer = ReturnType<typeof globalThis.setTimeout>> {
  clearTimeoutFn?: (timer: TTimer | null) => void;
  delay?: number;
  onRestore?: (threadId: string) => void;
  setTimeoutFn?: (callback: () => void, delay: number) => TTimer;
}

export interface ProgrammaticScrollGuard {
  begin(threadId: string): void;
  cancel(): void;
  isActive(): boolean;
}

export function createProgrammaticScrollGuard<TTimer = ReturnType<typeof globalThis.setTimeout>>(
  options?: ProgrammaticScrollGuardOptions<TTimer>,
): ProgrammaticScrollGuard;
