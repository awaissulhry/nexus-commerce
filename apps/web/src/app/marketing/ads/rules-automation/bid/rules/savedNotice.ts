/**
 * Bid page, Rules view — what the rule's detail says right after the builder saved it (2026-10-11, lane BID-FIX2).
 *
 * It used to be a toast ("Rule created · Undo"), but the toast sat under the detail's backdrop: no click and no Tab could
 * reach its Undo. Now it is a DS Banner at the top of the detail, as on the Negative Targeting page (same words): "Rule
 * created" with Undo (it archives the rule again), or "Saved". It stays until it is dismissed or the detail leaves that
 * rule (closed, Back, Prev / Next, Edit all).
 */

/** The notice the page holds: the rule it is about and how it went. */
export interface SavedNotice {
  id: string
  kind: 'created' | 'updated'
  /** The Undo (archive) is on its way. */
  busy: boolean
  /** The Undo was refused: the server's words. */
  error: string | null
}

export interface NoticeWords {
  tone: 'success' | 'warning'
  title: string
  body: string | null
  /** A new rule offers Undo; a saved edit does not (as before). */
  undo: boolean
}

export function savedNotice(id: string, kind: SavedNotice['kind']): SavedNotice {
  return { id, kind, busy: false, error: null }
}

export function noticeWords(n: SavedNotice): NoticeWords {
  if (n.kind === 'updated') return { tone: 'success', title: 'Saved', body: null, undo: false }
  return {
    tone: n.error ? 'warning' : 'success',
    title: 'Rule created',
    body: n.error ? `Not undone: ${n.error}` : 'Undo archives it again.',
    undo: true,
  }
}

/**
 * Keep the notice while the detail is on its rule. Before the detail has opened on it (the builder is still leaving), it
 * waits; once seen, the detail on any other rule — or none — ends it.
 */
export function followNotice(n: SavedNotice | null, seen: boolean, panelId: string | null): { keep: boolean; seen: boolean } {
  if (!n) return { keep: false, seen: false }
  if (panelId === n.id) return { keep: true, seen: true }
  return { keep: !seen, seen }
}
