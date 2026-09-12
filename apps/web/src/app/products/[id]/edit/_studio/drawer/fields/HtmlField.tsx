'use client'

/**
 * PES.4.4 — the DS long-form editor. No dependency.
 *
 * Decision B, 2026-09-01: there is no rich-text library anywhere in this repo (no TipTap, Quill,
 * Lexical, Slate or ProseMirror in any package.json), and description editing today is a raw HTML
 * `<textarea>`. Marketplace descriptions are a narrow HTML subset — Amazon strips nearly all of
 * it, eBay allows a little more — so a full editing framework would be a large dependency bought
 * for tables nobody is allowed to ship. This is `contenteditable` plus the six marks that survive
 * a marketplace, and a source view for the operators who would rather type the tags.
 *
 * TWO invariants:
 *
 * 1. **Sanitise on the way OUT, always.** Pasting into a contenteditable brings whatever was on
 *    the clipboard — Word spans, tracking pixels, `<script>`, `onerror=`. `sanitize()` below is an
 *    ALLOWLIST: unknown elements are unwrapped (their text survives), every attribute except a
 *    tiny set is dropped, and an `href` that is not http/https/mailto is removed. Nothing reaches
 *    the server that did not pass it, in either mode.
 *
 * 2. **Never write into the DOM while the caret is in it.** A controlled contenteditable that
 *    re-renders on its own value puts the caret back at position zero on every keystroke. So the
 *    element is uncontrolled while focused and re-synced only when the value changed elsewhere —
 *    a copy-across from the compare pane, a 409 repaint — and the operator is not typing.
 */

import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { Bold, Code, Italic, Link2, List, ListOrdered, RemoveFormatting } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Textarea } from '@/design-system/primitives/Textarea'
import { Input } from '@/design-system/primitives/Input'
import { ToolbarButton } from '@/design-system/primitives/ToolbarButton'
import { longTextState } from '@/design-system/grid/renderers/longTextState'
import { overCapNote } from '../format'
import styles from '../drawer.module.css'

/** Elements a marketplace description may carry. Anything else is unwrapped, not deleted. */
const ALLOWED = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'A', 'H3', 'H4', 'H5', 'SPAN', 'DIV',
])
/** The only attributes that survive, per element. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href', 'title', 'target', 'rel']),
}
const SAFE_HREF = /^(https?:|mailto:)/i

/**
 * Allowlist sanitiser. Runs in the browser (DOMParser); on the server it returns the input
 * unchanged, which is safe because nothing server-side writes through this field — but the value
 * is sanitised again on every commit path below, so no unsanitised string can reach a write.
 */
export function sanitize(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  const walk = (node: Element) => {
    // Snapshot the children: unwrapping mutates the live list underneath the loop.
    for (const child of Array.from(node.children)) walk(child)

    if (!ALLOWED.has(node.tagName)) {
      // Unwrap rather than remove — the operator's TEXT is not the thing being rejected, the
      // markup around it is. Deleting the node would silently eat a paragraph of copy.
      const parent = node.parentNode
      if (parent) {
        while (node.firstChild) parent.insertBefore(node.firstChild, node)
        parent.removeChild(node)
      }
      return
    }

    const allowed = ALLOWED_ATTRS[node.tagName]
    for (const attr of Array.from(node.attributes)) {
      if (!allowed?.has(attr.name.toLowerCase())) {
        // This is what drops every `on*` handler and every `style` — by not being on the list,
        // not by being recognised as dangerous. An allowlist cannot be out-guessed.
        node.removeAttribute(attr.name)
      }
    }
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      if (!SAFE_HREF.test(href)) node.removeAttribute('href')
      // An external link opened by the operator must not hand the opener to the target.
      if (node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer')
    }
  }

  for (const child of Array.from(doc.body.children)) walk(child)
  return doc.body.innerHTML
}

export interface HtmlFieldProps {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  disabled?: boolean
  /**
   * Caps from the channel schema, counted on the TEXT rather than the markup.
   *
   * 🔴 BOTH units, because neither always binds (#382). This took `maxLength` alone, so
   * `product_description` (no `maxLength` on the wire at all, `maxBytes: 20000`) rendered NO cap
   * whatsoever — the uncapped unit is OMITTED, not sent as null (measured 2026-09-02, null 0 of 96) — and
   * `RecordField` suppresses its own counter for `longtext` precisely because this component is
   * supposed to own it. Worse, the call site never passed even the character cap, so every
   * rich-text field in the drawer was uncapped while the sheet enforced one.
   */
  maxLength?: number | null
  maxBytes?: number | null
  /** Which channel imposes the binding cap, e.g. "Amazon · IT". */
  capFrom?: string | null
  ariaLabel?: string
}

export function HtmlField({
  value,
  onCommit,
  placeholder,
  disabled,
  maxLength,
  maxBytes,
  capFrom,
  ariaLabel,
}: HtmlFieldProps) {
  const area = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState(false)
  const [draft, setDraft] = useState(value)
  /** Plain text as typed, for the cap count only. Null = not typing; read the DOM instead. */
  const [liveText, setLiveText] = useState<string | null>(null)
  const id = useId()

  // Re-sync from the prop only when the operator is not in the field. See invariant 2.
  useEffect(() => {
    setDraft(value)
    // A new value from outside supersedes anything typed — re-derive rather than keep a stale count.
    setLiveText(null)
    const el = area.current
    if (!el || document.activeElement === el) return
    if (el.innerHTML !== value) el.innerHTML = value
  }, [value])

  const commit = useCallback(
    (html: string) => {
      const clean = sanitize(html)
      setDraft(clean)
      if (clean !== value) onCommit(clean)
    },
    [onCommit, value],
  )

  /**
   * `document.execCommand` is formally deprecated and has no replacement that works on a plain
   * contenteditable — every editor framework that claims otherwise ships its own model. It is
   * implemented in every browser this app supports, and the output is sanitised on commit
   * regardless of what any engine produces.
   */
  const exec = useCallback(
    (cmd: string, arg?: string) => {
      const el = area.current
      if (!el || disabled) return
      el.focus()
      document.execCommand(cmd, false, arg)
      commit(el.innerHTML)
    },
    [commit, disabled],
  )

  // Paste as PLAIN TEXT. The sanitiser would strip a Word paste to nothing recognisable anyway,
  // and doing it here means the operator sees what they will get at the moment they paste,
  // rather than after a save round-trip changed it under them.
  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain')
      document.execCommand('insertText', false, text)
      if (area.current) commit(area.current.innerHTML)
    },
    [commit],
  )

  /**
   * Linking is an inline row, not `window.prompt`. A native prompt is unstyleable, untestable,
   * blocks the whole tab, and — the reason that actually decides it — it steals the SELECTION:
   * by the time the operator has typed a URL the range they highlighted is gone, so the link
   * lands nowhere. The range is captured before the row opens and restored before the command.
   */
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')
  const savedRange = useRef<Range | null>(null)

  const openLink = useCallback(() => {
    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    setHref('')
    setLinking(true)
  }, [])

  const applyLink = useCallback(() => {
    const url = href.trim()
    if (!SAFE_HREF.test(url)) return
    const el = area.current
    if (el && savedRange.current) {
      el.focus()
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange.current)
    }
    exec('createLink', url)
    setLinking(false)
  }, [exec, href])

  // `liveText` while the operator is typing; otherwise derive from what is actually in the DOM.
  const text = liveText ?? (typeof document === 'undefined' ? draft : (area.current?.innerText ?? '').trim())
  // The shared reader, so this field and the sheet cell cannot disagree about one value — and so
  // the byte/character choice is made per CONTENT rather than picked here.
  const reading = longTextState(text, { maxLength, maxBytes, capFrom })
  const over = reading.state === 'over'

  return (
    <div className={styles.rt}>
      <div className={styles.rtBar} role="toolbar" aria-label="Formatting" aria-controls={id}>
        <ToolbarButton icon={<Bold size={13} />} label="Bold" onClick={() => exec('bold')} disabled={disabled || source} />
        <ToolbarButton icon={<Italic size={13} />} label="Italic" onClick={() => exec('italic')} disabled={disabled || source} />
        <ToolbarButton icon={<List size={13} />} label="Bulleted list" onClick={() => exec('insertUnorderedList')} disabled={disabled || source} />
        <ToolbarButton icon={<ListOrdered size={13} />} label="Numbered list" onClick={() => exec('insertOrderedList')} disabled={disabled || source} />
        <ToolbarButton icon={<Link2 size={13} />} label="Add link" onClick={openLink} disabled={disabled || source} aria-expanded={linking} />
        <ToolbarButton icon={<RemoveFormatting size={13} />} label="Clear formatting" onClick={() => exec('removeFormat')} disabled={disabled || source} />
        <span className={styles.rtSpacer} />
        <ToolbarButton
          icon={<Code size={13} />}
          label={source ? 'Back to visual editing' : 'Edit the HTML source'}
          active={source}
          onClick={() => {
            // Leaving source view commits what is in the box, so the two views never disagree.
            if (source) commit(draft)
            setSource((s) => !s)
          }}
          disabled={disabled}
        />
      </div>

      {linking && (
        <div className={styles.rtBar}>
          <Input
            size="sm"
            autoFocus
            value={href}
            placeholder="https://…"
            aria-label="Link URL"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                // Stop here: the dock's Esc-to-close is listening on document, and cancelling a
                // link entry must not also shut the record.
                e.stopPropagation()
                setLinking(false)
              }
            }}
          />
          <Button
            size="xs"
            variant="primary"
            disabled={!SAFE_HREF.test(href.trim())}
            title={SAFE_HREF.test(href.trim()) ? undefined : 'Only http://, https:// and mailto: links can be saved'}
            onClick={applyLink}
          >
            Add
          </Button>
          <Button size="xs" onClick={() => setLinking(false)}>
            Cancel
          </Button>
        </div>
      )}

      {source ? (
        <Textarea
          id={id}
          className={styles.rtSource}
          value={draft}
          disabled={disabled}
          aria-label={ariaLabel ? `${ariaLabel} — HTML source` : 'HTML source'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          spellCheck={false}
        />
      ) : (
        <div
          id={id}
          ref={area}
          className={styles.rtArea}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          data-placeholder={placeholder ?? ''}
          onPaste={onPaste}
          /**
           * 🔴 Without this the cap counter never moved while you typed.
           *
           * `draft` only changed on blur, and the reading was derived from `area.current.innerText`
           * — a REF, which does not trigger a render. So the count updated only after leaving the
           * field: the one moment it is useless, since the point of a cap is to warn you before you
           * commit 24,000 bytes to a 20,000-byte column.
           *
           * It sets a separate `liveText` rather than `draft` deliberately: writing draft on every
           * keystroke re-renders the contentEditable with new children and collapses the caret to
           * the start. This value is only ever READ for the count, never written back into the DOM.
           */
          onInput={(e) => setLiveText(e.currentTarget.innerText)}
          onBlur={(e) => commit(e.currentTarget.innerHTML)}
        />
      )}

      {reading.cap != null && (
        <div className={styles.capRow}>
          {/* 🔴 Exactly ONE surface names the source at a time, and which one depends on state
              (DS1-25 / DS.1's ruling). Not over: there is no message, so this span carries it.
              Over: `overCapNote` carries it and this span stands down. The condition is written as
              "only when nothing else is saying it" rather than "not while over", because the span
              is the source-carrier of LAST RESORT, not a label — read as an exception, the next
              person deletes the `!over` as dead tidying. The drawer is the only surface with a left
              span (DS.1 checked the mark and the validator), so this is the only place the source
              could appear twice, and only in the over state. */}
          <span>{!over && reading.capFrom ? `cap from ${reading.capFrom}` : ''}</span>
          <span className={over ? styles.capOver : undefined}>
            {reading.length} / {reading.cap} {reading.unit}
            {over ? overCapNote(reading.capFrom) : ''}
          </span>
        </div>
      )}
    </div>
  )
}
