/**
 * FS3 — AsyncCombobox: single-select typeahead fed by a SERVER loader
 * (q, cursor) instead of a whole-table options array — the fix for the
 * S-16 scale-growing pickers. Debounce 200ms, cursor paging ("Load more" +
 * auto-page when ArrowDown walks off the end), full keyboard nav
 * (↑/↓/Enter/Escape), loading + "No matches" states. Markup reuses the DS
 * Combobox classes (`.h10-ds-combo*`) for visual parity; the DS tree itself
 * stays untouched (PROVENANCE rule 2).
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useClickAway } from "@/design-system/components/useClickAway";
import {
  createSearchController,
  moveActive,
  type AsyncOption,
  type SearchLoader,
  type SearchState,
} from "@/lib/virtual/async-search";

export type { AsyncOption, SearchLoader } from "@/lib/virtual/async-search";

export interface AsyncComboboxProps {
  /** server search: (q, cursor) → { options, nextCursor } */
  loader: SearchLoader;
  value?: string;
  /** label shown for `value` while the input is closed (options are server-side) */
  valueLabel?: string;
  onChange: (value: string, option: AsyncOption) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  debounceMs?: number;
  emptyText?: string;
  /** called when the popover closes without a pick (blur/Escape) */
  onDismiss?: () => void;
  ariaLabel?: string;
}

export function AsyncCombobox({
  loader,
  value,
  valueLabel,
  onChange,
  placeholder = "Search…",
  className,
  disabled,
  autoFocus,
  debounceMs = 200,
  emptyText = "No matches",
  onDismiss,
  ariaLabel,
}: AsyncComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState<SearchState>({ q: "", options: [], nextCursor: null, loading: false, loadingMore: false, error: null });
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

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

  const close = (dismissed: boolean) => {
    setOpen(false);
    setQuery("");
    setActive(-1);
    if (dismissed) onDismiss?.();
  };
  useClickAway(ref, () => close(true), open);

  const openAndSeed = () => {
    if (disabled || open) return;
    setOpen(true);
    setActive(-1);
    controller.setQuery("");
    controller.load();
  };

  // reset highlight when a fresh result list lands
  useEffect(() => {
    setActive((a) => (a >= search.options.length ? search.options.length - 1 : a));
  }, [search.options.length]);

  const pick = (o: AsyncOption) => {
    onChange(o.value, o);
    close(false);
  };

  const scrollActiveIntoView = (idx: number) => {
    const btn = popRef.current?.querySelectorAll<HTMLButtonElement>("button[role='option']")[idx];
    btn?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close(true);
      }
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      openAndSeed();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = moveActive(active, delta, search.options.length);
      setActive(next);
      scrollActiveIntoView(next);
      // walking off the end pulls the next page in
      if (delta === 1 && active === search.options.length - 1 && search.nextCursor) controller.loadMore();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = search.options[active] ?? (search.options.length === 1 ? search.options[0] : undefined);
      if (o) pick(o);
    }
  };

  const shownLabel = open ? query : valueLabel ?? "";

  return (
    <div
      className={`h10-ds-combo${className ? ` ${className}` : ""}`}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      <input
        className="h10-ds-combo-in"
        value={shownLabel}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        onFocus={openAndSeed}
        onChange={(e) => {
          if (!open) setOpen(true);
          setQuery(e.target.value);
          setActive(-1);
          controller.setQuery(e.target.value.trim());
        }}
      />
      {search.loading || search.loadingMore ? (
        <Loader2 size={15} className="chev" style={{ animation: "h10-ds-spin 0.8s linear infinite" }} aria-hidden />
      ) : (
        <ChevronDown size={15} className="chev" aria-hidden />
      )}
      {open && (
        <div className="h10-ds-combo-pop" role="listbox" ref={popRef}>
          {search.error ? (
            <div className="h10-ds-combo-empty">{search.error}</div>
          ) : search.loading ? (
            <div className="h10-ds-combo-empty">Searching…</div>
          ) : search.options.length === 0 ? (
            <div className="h10-ds-combo-empty">{emptyText}</div>
          ) : (
            <>
              {search.options.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={[o.value === value ? "on" : "", i === active ? "hover" : ""].filter(Boolean).join(" ") || undefined}
                  style={i === active ? { background: "var(--h10-surface-hover)" } : undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  {o.label}
                  {o.hint && <span style={{ color: "var(--text-tertiary)", fontSize: 11.5, marginLeft: 6 }}>{o.hint}</span>}
                </button>
              ))}
              {search.nextCursor && (
                <button type="button" onClick={() => controller.loadMore()} disabled={search.loadingMore} style={{ color: "var(--h10-primary)", fontWeight: 600 }}>
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
