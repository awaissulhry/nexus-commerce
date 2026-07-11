/**
 * FS3 — MentionTextarea: a plain textarea + `@`-trigger popover riding the
 * AsyncCombobox internals (the same createSearchController: debounce, paging,
 * stale-drop) fed by a caller-supplied loader (users search). Picking inserts
 * `@handle ` (dotted display name — the exact form src/lib/comments.ts
 * resolveMentions matches), then the SERVER keeps resolving mentions
 * unchanged. Pure UI: export-only for now — the EPI session owns wiring it
 * into the inbox composer.
 */
"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  createSearchController,
  moveActive,
  type AsyncOption,
  type SearchLoader,
  type SearchState,
} from "@/lib/virtual/async-search";
import { handleFor, insertMention, mentionQueryAt, type MentionToken } from "@/lib/virtual/mention";

export interface MentionTextareaProps {
  value: string;
  onChange: (next: string) => void;
  /** server search over users: (q, cursor) → { options, nextCursor }; label = display name */
  loader: SearchLoader;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  /** forwarded so parents can keep focus/shortcut behavior (e.g. ⌘Enter submit) */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  debounceMs?: number;
}

export function MentionTextarea({
  value,
  onChange,
  loader,
  placeholder,
  rows = 3,
  disabled,
  className,
  style,
  ariaLabel,
  onKeyDown,
  textareaRef,
  debounceMs = 200,
}: MentionTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const [token, setToken] = useState<MentionToken | null>(null);
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState<SearchState>({ q: "", options: [], nextCursor: null, loading: false, loadingMore: false, error: null });

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const controller = useMemo(
    () =>
      createSearchController({
        loader: (q, cursor) => loaderRef.current(q, cursor),
        debounceMs,
        onState: setSearch,
      }),
    [debounceMs],
  );
  useEffect(() => () => controller.dispose(), [controller]);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof textareaRef === "function") textareaRef(el);
    else if (textareaRef && "current" in textareaRef) (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };

  const syncToken = (text: string, caret: number) => {
    const t = mentionQueryAt(text, caret);
    setToken(t);
    if (t) {
      setActive(0);
      controller.setQuery(t.query);
    }
  };

  const pick = (o: AsyncOption) => {
    const el = innerRef.current;
    if (!el || !token) return;
    const caret = el.selectionStart ?? value.length;
    const res = insertMention(value, token, caret, handleFor(o.label));
    onChange(res.text);
    setToken(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(res.caret, res.caret);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (token && search.options.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = moveActive(active, delta, search.options.length);
        setActive(next);
        if (delta === 1 && active === search.options.length - 1 && search.nextCursor) controller.loadMore();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const o = search.options[active] ?? search.options[0];
        if (o) pick(o);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setToken(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const open = !!token;

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={setRefs}
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className={className}
        style={style}
        onChange={(e) => {
          onChange(e.target.value);
          syncToken(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={handleKeyDown}
        onClick={(e) => syncToken(value, (e.target as HTMLTextAreaElement).selectionStart ?? value.length)}
        onBlur={() => setTimeout(() => setToken(null), 150) /* let a popover click land first */}
      />
      {open && (
        <div className="h10-ds-combo-pop" role="listbox" style={{ top: "100%" }}>
          {search.loading ? (
            <div className="h10-ds-combo-empty">Searching…</div>
          ) : search.options.length === 0 ? (
            <div className="h10-ds-combo-empty">No matches</div>
          ) : (
            <>
              {search.options.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  style={i === active ? { background: "var(--h10-surface-hover)" } : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
                  onClick={() => pick(o)}
                >
                  {o.label}
                  <span style={{ color: "var(--text-tertiary)", fontSize: 11.5, marginLeft: 6 }}>@{handleFor(o.label)}</span>
                </button>
              ))}
              {search.nextCursor && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => controller.loadMore()} disabled={search.loadingMore} style={{ color: "var(--h10-primary)", fontWeight: 600 }}>
                  {search.loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
