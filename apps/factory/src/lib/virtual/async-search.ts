/**
 * FS3 — the framework-free search controller behind AsyncCombobox and
 * MentionTextarea: debounced server search (`q`), cursor paging (`loadMore`
 * appends), stale-response drop (a slow page for an old query never lands),
 * plus the keyboard-index math. React components subscribe via `onState`;
 * everything here runs in plain node so the behavior is unit-testable.
 */

export interface AsyncOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SearchPage {
  options: AsyncOption[];
  nextCursor: string | null;
}

/** Server search: `q` (may be empty = browse) + opaque `cursor` (null = first page). */
export type SearchLoader = (q: string, cursor: string | null) => Promise<SearchPage>;

export interface SearchState {
  q: string;
  options: AsyncOption[];
  nextCursor: string | null;
  /** first page in flight (list replaced when it lands) */
  loading: boolean;
  /** follow-up page in flight (list appended when it lands) */
  loadingMore: boolean;
  error: string | null;
}

export interface SearchController {
  /** debounced: schedules a first-page load for `q` after `debounceMs` */
  setQuery(q: string): void;
  /** immediate first-page load for the current query (open-popover seed) */
  load(): void;
  /** fetch + append the next page; no-op without a cursor or while busy */
  loadMore(): void;
  getState(): SearchState;
  dispose(): void;
}

const initialState = (): SearchState => ({ q: "", options: [], nextCursor: null, loading: false, loadingMore: false, error: null });

export function createSearchController(opts: {
  loader: SearchLoader;
  onState: (s: SearchState) => void;
  debounceMs?: number;
}): SearchController {
  const debounceMs = opts.debounceMs ?? 200;
  let state = initialState();
  let seq = 0; // bumps on every first-page request; stale responses are dropped
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const emit = (patch: Partial<SearchState>) => {
    state = { ...state, ...patch };
    if (!disposed) opts.onState(state);
  };

  const fetchFirst = () => {
    const mySeq = ++seq;
    emit({ loading: true, error: null });
    opts.loader(state.q, null).then(
      (page) => {
        if (mySeq !== seq || disposed) return; // a newer query superseded this one
        emit({ options: page.options, nextCursor: page.nextCursor, loading: false, loadingMore: false });
      },
      (e) => {
        if (mySeq !== seq || disposed) return;
        emit({ loading: false, loadingMore: false, error: (e as Error).message || "Search failed" });
      },
    );
  };

  return {
    setQuery(q: string) {
      if (timer) clearTimeout(timer);
      emit({ q });
      timer = setTimeout(() => {
        timer = null;
        fetchFirst();
      }, debounceMs);
    },
    load() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fetchFirst();
    },
    loadMore() {
      if (!state.nextCursor || state.loading || state.loadingMore) return;
      const mySeq = seq;
      const cursor = state.nextCursor;
      emit({ loadingMore: true });
      opts.loader(state.q, cursor).then(
        (page) => {
          if (mySeq !== seq || disposed) return; // query changed while paging
          const seen = new Set(state.options.map((o) => o.value));
          emit({
            options: [...state.options, ...page.options.filter((o) => !seen.has(o.value))],
            nextCursor: page.nextCursor,
            loadingMore: false,
          });
        },
        () => {
          if (mySeq !== seq || disposed) return;
          emit({ loadingMore: false });
        },
      );
    },
    getState: () => state,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Keyboard-highlight math: move the active index by `delta`, clamping to
 * [0, count-1]; entering a list from nowhere (-1) lands on the first/last row.
 */
export function moveActive(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, index + delta));
}
