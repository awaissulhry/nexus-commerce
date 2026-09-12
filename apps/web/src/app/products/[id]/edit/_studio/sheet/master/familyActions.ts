/**
 * Family actions, declared once for every Information-grid surface.
 *
 * Declared as `GridAction`s so the family bar, the row menu, the selection bar and the drawer all
 * render the same rules (ruling #110). Nothing here renders anything; `runAction` runs them.
 *
 * Attach, unlink, move and promote preserve products. Delete checks marketplace ownership;
 * demotion confirms the exact children that will become standalone products.
 *
 * 🔴 THE PERMISSION SPLIT — the finding that shaped this file.
 *
 * Three of the four verbs live under `/api/pim` and need `pim.manage`. **Unlink lives under
 * `/api/amazon` and needs `channels.sync`** (permissions-manifest.ts:353 vs :383). They are not the
 * same permission and there is no reason an operator would expect them to be, because nothing about
 * "unlink this child from its parent" suggests a channel-sync capability — it is an artefact of
 * where the endpoint was originally written.
 *
 * So an operator can genuinely hold three of these four and not the fourth, in either direction.
 * Without asking up front, Unlink would look identical to the others and fail at press-time with a
 * bare "Access denied" — the exact trap `reference_disabled_control_cannot_explain` names, where a
 * missing permission, a wrong selection and a bug are indistinguishable. So permission is an INPUT
 * here, and a verb the operator cannot use says which permission it wants.
 */

import {
  AVAILABLE,
  HIDDEN,
  ROW,
  SELECTION,
  contextOf,
  disabled,
  type ActionImpact,
  type ActionResult,
  type GridAction,
} from '@/design-system/grid/actions/registry'

import { ATTACH_MAX, UNLINK_MAX, type FamilyOps } from './familyOps'
import { classifyListings } from './listingRisk'
import { blocking, warnings, validateNewVariation, type NewVariationDraft } from './addVariation'
import type { FamilyResponse } from './family'
import type { StudioRow } from './types'

export const PERM_PIM = 'pim.manage'
export const PERM_UNLINK = 'channels.sync'
/** 🔴 A THIRD permission. Delete is served from `/api/catalog`, gated `products.edit`. */
export const PERM_DELETE = 'products.edit'

/**
 * Whether the session's permissions are even KNOWN yet.
 *
 * 🔴 Measured, not assumed. On this machine the app talks to a local API on :8091 for which the
 * browser holds no session cookie, so `/api/auth/me` answers 401 and `AuthProvider` sits at `anon`
 * with an empty permission set — while the very same account is the Owner against the deployed API.
 * A `can()` that is merely false in that state is indistinguishable from a real denial, and saying
 * "which this account does not have" to the Owner is a UI telling a confident lie. Three states,
 * three different sentences.
 */
export type AuthStatus = 'loading' | 'authed' | 'anon'

export interface FamilyActionContext {
  family: FamilyResponse | null
  ops: FamilyOps
  /** What the operator holds. Asked once by the surface, never guessed here. */
  can: (permission: string) => boolean
  /** Opens the record drawer. Absent when the surface has no drawer to open. */
  openRecord?: (rowId: string) => void
  /** The record already open, if any — `open-record` hides itself on it (PES.3's rule). */
  openRecordId?: string | null
  /**
   * REQUIRED, deliberately. It was optional with an `'authed'` default, which is the same trap one
   * step quieter: a caller who simply forgot would get "which this account does not have" — a
   * confident claim about a real person's permissions, *defaulted* rather than measured. A required
   * field cannot be forgotten, and there is no safe value to guess (ruling #141, "a measured
   * constant is still a constant").
   */
  authStatus: AuthStatus
  pickProduct?: (kind: 'parent' | 'standalone', exclude: string[]) => Promise<{ id: string; sku: string } | null>
  /**
   * Collected BEFORE the preflight, by the surface that owns the picker (COLLECT → PREFLIGHT →
   * CONFIRM → RUN). Attach and Move may collect their input through pickProduct instead.
   */
  pending?: {
    /** For attach: which standalone products, and the axis values chosen for each. */
    attach?: { productIds: string[]; axisValues?: Record<string, Record<string, string>> }
    /** For reparent: the parent the selected rows would move under. */
    reparentTo?: { id: string; sku: string }
    /** For add-variation: the draft the operator filled in. */
    newVariation?: NewVariationDraft
  }
}

const plural = (n: number, one: string, many = one === 'child' ? 'children' : `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * A permission refusal names the permission — "ask for it" is actionable, "denied" is not.
 *
 * And it only claims the ACCOUNT lacks something when the account is actually known. Otherwise it
 * says what is true: nobody has been asked yet.
 */
const needsPermission = (status: AuthStatus, permission: string, verb: string) =>
  disabled(
    status === 'loading'
      ? `Checking whether this session may use ${verb.toLowerCase()}…`
      : status === 'anon'
        ? `${verb} needs the "${permission}" permission, and this session is not signed in — so it cannot be checked`
        : `${verb} needs the "${permission}" permission, which this account does not have`,
  )

export function familyActions(ctx: FamilyActionContext): GridAction<StudioRow>[] {
  const { family, ops, can, pending, openRecord, openRecordId } = ctx
  const { authStatus } = ctx
  const needs = (permission: string, verb: string) => needsPermission(authStatus, permission, verb)
  const role = family?.role
  const parentId = family?.self.id ?? null

  return [
    /**
     * ATTACH — take existing standalone products in as children. Context verb: it acts on the
     * family, not on any row in the sheet (the products being attached are not in it yet).
     */
    {
      id: 'attach-existing',
      label: 'Attach existing…',
      scope: contextOf('product-family'),
      available: () => {
        if (role !== 'parent') return disabled('Only a parent can take existing products as children')
        if (!can(PERM_PIM)) return needs(PERM_PIM, 'Attaching')
        const n = pending?.attach?.productIds.length ?? 0
        if (n === 0 && !ctx.pickProduct) return disabled('Pick the products to attach first')
        if (n > ATTACH_MAX) return disabled(`The server accepts at most ${ATTACH_MAX} products per attach; ${n} were picked`)
        return AVAILABLE
      },
      preflight: async () => {
        const choice = pending?.attach?.productIds.length ? null : await ctx.pickProduct?.('standalone', parentId ? [parentId] : [])
        const picked = pending?.attach?.productIds ?? (choice ? [choice.id] : [])
        if (!picked.length) return { level: 'none', title: 'Attach cancelled', cancelled: true }
        const axes = pending?.attach?.axisValues ?? {}
        const withoutAxes = picked.filter((id) => Object.keys(axes[id] ?? {}).length === 0)
        return {
          level: 'confirm',
          title: `Attach ${plural(picked.length, 'product')} to ${family?.self.sku} as ${picked.length === 1 ? 'a child' : 'children'}?`,
          consequences: picked.map((id) => {
            const v = axes[id]
            const pairs = v ? Object.entries(v).map(([k, val]) => `${k}: ${val}`).join(', ') : ''
            const label = choice?.id === id ? choice.sku : id
            return pairs ? `${label} — ${pairs}` : `${label} — existing attribute values are kept`
          }),
          sideEffects: withoutAxes.length > 0
            ? ['Review the child’s variation values after attaching it to this family.']
            : undefined,
          // Ruling #118: run applies exactly what was described here.
          payload: { productIds: picked, axisValues: pending?.attach?.axisValues },
        }
      },
      run: async (_rows, impact) => {
        const p = (impact?.payload ?? {}) as { productIds?: string[]; axisValues?: Record<string, Record<string, string>> }
        if (!parentId || !p.productIds?.length) return { ok: false, message: 'Nothing to attach' }
        const res = await ops.attach(parentId, p.productIds, p.axisValues)
        // 🔴 This endpoint is partially successful BY DESIGN — one transaction per child. Reporting
        // it as a plain success would hide the failures the operator most needs to see.
        return {
          ok: res.errors.length === 0,
          message: res.errors.length
            ? `Attached ${res.attached} of ${p.productIds.length}. ${res.errors.map((e) => `${e.productId}: ${e.error}`).join('; ')}`
            : undefined,
          invalidates: { kind: 'page' },
        } satisfies ActionResult
      },
    },

    /**
     * UNLINK — detach children from their parent. Selection verb: it acts on the rows chosen.
     */
    {
      id: 'unlink',
      label: 'Unlink from parent',
      scope: SELECTION,
      available: (rows) => {
        if (rows.length === 0) return disabled('Select the children to unlink')
        const notChildren = rows.filter((r) => !r.parentId)
        if (notChildren.length > 0) {
          return disabled(
            notChildren.length === rows.length
              ? 'Only a child can be unlinked'
              : `${plural(notChildren.length, 'selected row')} ${notChildren.length === 1 ? 'is' : 'are'} not a child`,
          )
        }
        // 🔴 A DIFFERENT permission from the other three. See the header.
        if (!can(PERM_UNLINK)) return needs(PERM_UNLINK, 'Unlinking')
        if (rows.length > UNLINK_MAX) return disabled(`The server accepts at most ${UNLINK_MAX} rows per unlink; ${rows.length} are selected`)
        return AVAILABLE
      },
      preflight: async (rows) => {
        const childCount = family?.children.length ?? 0
        const emptiesTheParent = role === 'parent' && rows.length >= childCount && childCount > 0
        return {
          level: 'confirm',
          title: `Unlink ${plural(rows.length, 'child')} from ${family?.self.sku ?? 'the parent'}?`,
          consequences: rows.map((r) => r.sku),
          sideEffects: [
            // The server changes membership and version without clearing axis values.
            'The axis values are kept, so re-attaching restores the child as it was',
            // Relationship changes preserve the explicitly assigned Parent role.
            ...(emptiesTheParent
              ? [`${family?.self.sku} would be left as a parent with no children — unlink does not demote it`]
              : []),
            // Stated unconditionally rather than per row: on the MASTER scope the studio contract
            // returns `listing: null` for every row, so a per-row count of live listings is not
            // knowable here. A number I cannot measure is worse than a fact I can.
            'Channel listings are not changed — unlinking only breaks the parent/child link',
          ],
          payload: { ids: rows.map((r) => r.id), expectedParentId: rows[0]?.parentId },
        }
      },
      run: async (rows, impact) => {
        const ids = ((impact?.payload as { ids?: string[] } | undefined)?.ids) ?? rows.map((r) => r.id)
        const expectedParentId = (impact?.payload as { expectedParentId?: string } | undefined)?.expectedParentId ?? rows[0]?.parentId ?? undefined
        const res = await ops.unlink(ids, expectedParentId)
        return {
          // Successful batches report all requested IDs; missing products cause an atomic refusal.
          ok: res.detached === ids.length,
          message: res.detached === ids.length ? undefined : `${res.detached} of ${ids.length} rows were detached`,
          invalidates: { kind: 'page' },
        } satisfies ActionResult
      },
    },

    /**
     * REPARENT — move children under a different parent. One at a time: the endpoint takes a
     * single productId, and looping it client-side would turn one failure into a half-moved family.
     */
    {
      id: 'reparent',
      label: 'Move to another parent…',
      scope: SELECTION,
      available: (rows) => {
        if (rows.length === 0) return disabled('Select the child to move')
        if (rows.length > 1) return disabled('Move one child at a time — the server moves a single product per request')
        const [row] = rows
        if (!row.parentId) return disabled('Only a child can be moved to another parent')
        if (row.isParent) return disabled(`${row.sku} is a parent — demote it before moving it`)
        if (!can(PERM_PIM)) return needs(PERM_PIM, 'Moving a child')
        if (!pending?.reparentTo && !ctx.pickProduct) return disabled('Pick the parent to move it under first')
        if (pending?.reparentTo?.id === row.id) return disabled('A product cannot be its own parent')
        if (pending?.reparentTo?.id === row.parentId) return disabled(`${row.sku} is already under ${pending.reparentTo.sku}`)
        return AVAILABLE
      },
      preflight: async (rows) => {
        const [row] = rows
        const target = pending?.reparentTo ?? await ctx.pickProduct?.('parent', [row.id, row.parentId].filter((id): id is string => !!id))
        if (!target) return { level: 'none', title: 'Move cancelled', cancelled: true }
        const isLastChild = (family?.children.length ?? 0) === 1 && row?.parentId === family?.self.id
        return {
          level: 'confirm',
          title: `Move ${row?.sku} under ${target?.sku}?`,
          consequences: [`${row?.sku} leaves ${family?.self.sku} and joins ${target?.sku}`],
          // Moving the last child preserves the explicitly assigned Parent role.
          sideEffects: isLastChild
            ? [`${family?.self.sku} would have no children and remain a Parent. Demote it separately if needed.`]
            : undefined,
          payload: { productId: row?.id, newParentId: target?.id, expectedParentId: row?.parentId },
        }
      },
      run: async (rows, impact) => {
        const p = (impact?.payload ?? {}) as { productId?: string; newParentId?: string; expectedParentId?: string }
        const productId = p.productId ?? rows[0]?.id
        const newParentId = p.newParentId ?? pending?.reparentTo?.id
        if (!productId || !newParentId) return { ok: false, message: 'No target parent was chosen' }
        const res = await ops.reparent(productId, newParentId, p.expectedParentId ?? rows[0]?.parentId ?? undefined)
        return {
          ok: res.success,
          message: res.oldParentId ? undefined : 'Moved, though the product had no previous parent',
          invalidates: { kind: 'page' },
        } satisfies ActionResult
      },
    },

    /**
     * PROMOTE — make this standalone product a parent so it can hold children. Context verb: the
     * subject is the product the studio is open on, which is not a row the sheet lets you select.
     */
    {
      id: 'promote',
      label: 'Promote to parent…',
      scope: contextOf('product-family'),
      available: () => {
        // Disabled rather than HIDDEN while the family is unknown: a verb that appears a moment
        // after the bar renders reads as a glitch, and "still loading" is a true reason.
        if (!family) return disabled('Loading the family…')
        if (role === 'parent') return disabled('This product is already a parent')
        if (role === 'child') return disabled('A child cannot be promoted; unlink it first')
        if (!can(PERM_PIM)) return needs(PERM_PIM, 'Promoting')
        return AVAILABLE
      },
      preflight: async () => {
        const axes = family?.self.variationAxes ?? []
        return {
          level: 'confirm',
          title: `Make ${family?.self.sku} a parent?`,
          consequences: [
            axes.length > 0
              ? `It would vary by ${axes.join(' × ')}`
              : 'It has no variation axes set, so the family would not yet know what its children differ by',
          ],
          sideEffects: ['Nothing is deleted — demoting it again reverses this'],
          payload: { productId: family?.self.id, axes },
        } satisfies ActionImpact
      },
      run: async (_rows, impact) => {
        const p = (impact?.payload ?? {}) as { productId?: string; axes?: string[] }
        if (!p.productId) return { ok: false, message: 'No product to promote' }
        const res = await ops.promote(p.productId, family?.self.variationTheme ?? undefined, p.axes)
        return { ok: res.success, invalidates: { kind: 'page' } } satisfies ActionResult
      },
    },

    /**
     * OPEN RECORD — one of the three explicit affordances that replace double-click (spec §7.3).
     *
     * 🔴 HIDDEN on the record already open, not disabled (PES.3's rule, and it is right): a verb
     * offered on the very thing it would open is meaningless rather than unavailable, and a
     * disabled entry with the reason "it is already open" is noise where absence says it better.
     *
     * Row-scoped, so both menu adapters offer it and neither had to be told about it — that is the
     * registry paying for itself: the gesture was removed in `MasterSheet` and the replacement
     * appeared on two surfaces from one declaration.
     */
    {
      id: 'open-record',
      label: 'Open record',
      scope: ROW,
      available: (rows) => {
        if (!openRecord || rows.length !== 1) return HIDDEN
        return rows[0]?.id === openRecordId ? HIDDEN : AVAILABLE
      },
      run: async (rows) => {
        const id = rows[0]?.id
        if (!id) return { ok: false, message: 'No row to open' }
        openRecord?.(id)
        // Opening a drawer changes nothing on the server, so nothing is invalidated.
        return { ok: true, invalidates: { kind: 'none' } } satisfies ActionResult
      },
    },

    /**
     * ADD VARIATION — F4. Parameterised: COLLECT (the form) → PREFLIGHT → CONFIRM → RUN, the order
     * `PARAMETERISED_VERB_ORDER` documents. The surface owns the form and folds the draft into
     * `pending`; nothing here renders anything.
     */
    {
      id: 'add-variation',
      label: 'Add child',
      scope: contextOf('product-family'),
      available: () => {
        if (!family) return disabled('Loading the family…')
        if (role !== 'parent') return disabled('Only a parent can hold children — promote this product first')
        if (!can(PERM_DELETE)) return needs(PERM_DELETE, 'Adding a child')
        // 🔴 Deliberately NOT gated on a collected draft. Availability answers "may this verb run
        // for this family and this operator"; the draft is a STEP that has not happened yet, and
        // encoding it here would disable the very button that opens the form — the verb could then
        // never be started at all. A missing draft is caught by the preflight instead, where a
        // refusal is the right shape for it.
        return AVAILABLE
      },
      preflight: async () => {
        const d = pending?.newVariation
        if (!d) return { level: 'none', title: 'Nothing to add', unavailable: 'No child was filled in' }
        const blockers = blocking(validateNewVariation(d, family))
        // A draft that cannot be created is refused with the server's-eye reason, verbatim — "A SKU
        // is required" is actionable; "the form is invalid" is not.
        if (blockers.length > 0) return { level: 'none', title: `Add ${d.sku || 'child'}?`, unavailable: blockers[0].message }
        const axisPairs = Object.entries(d.axisValues)
          .filter(([, v]) => String(v ?? '').trim())
          .map(([k, v]) => `${k}: ${v}`)
        const copyFrom = d.copyFromProductId
          ? family?.children.find((c) => c.id === d.copyFromProductId)?.sku ?? d.copyFromProductId
          : null
        return {
          level: 'confirm',
          title: `Add ${d.sku} to ${family?.self.sku}?`,
          consequences: [
            `${d.sku} — ${d.name}`,
            axisPairs.length > 0 ? axisPairs.join(', ') : 'No axis values set',
            ...(copyFrom ? [`Channel content copied from ${copyFrom}, without its axis-specific fields`] : []),
          ],
          sideEffects: [
            // 🔴 The thing the verb's name hides, and the reason this has a confirm at all.
            'It is created as a draft with channel sync disabled. Review it before publishing.',
            ...warnings(validateNewVariation(d, family)).map((w) => w.message),
          ],
          payload: { parentId: family?.self.id, draft: d },
        }
      },
      run: async (_rows, impact) => {
        const p = (impact?.payload ?? {}) as { parentId?: string; draft?: NewVariationDraft }
        const d = p.draft
        if (!p.parentId || !d) return { ok: false, message: 'No child to add' }
        const price = String(d.basePrice ?? '').trim()
        const stock = String(d.totalStock ?? '').trim()
        const axisValues = Object.fromEntries(
          Object.entries(d.axisValues).filter(([, v]) => String(v ?? '').trim()),
        )
        const res = await ops.addVariation(p.parentId, {
          sku: d.sku.trim(),
          name: d.name.trim(),
          ...(price ? { basePrice: Number(price) } : {}),
          ...(stock ? { totalStock: Number(stock) } : {}),
          ...(Object.keys(axisValues).length > 0 ? { variantAttributes: axisValues } : {}),
          ...(d.copyFromProductId ? { copyFromProductId: d.copyFromProductId, copyGroups: ['content', 'attributes'] } : {}),
        })
        return { ok: !!res?.success, invalidates: { kind: 'page' } } satisfies ActionResult
      },
    },

    /**
     * DELETE CHILD — one local product at a time. The preflight refuses marketplace records;
     * the transaction repeats that check and protects alias membership before hard deletion.
     */
    {
      id: 'delete-variant',
      label: 'Delete child…',
      scope: SELECTION,
      danger: true,
      available: (rows) => {
        if (rows.length === 0) return disabled('Select the child to delete')
        if (rows.length > 1) return disabled('Delete one child at a time, so the confirmation can name what it destroys')
        const [row] = rows
        if (row.isParent) return disabled(`${row.sku} is a parent — a parent is removed by demoting it`)
        if (!row.parentId) return disabled('Only a child can be deleted here')
        if (!can(PERM_DELETE)) return needs(PERM_DELETE, 'Deleting a child')
        return AVAILABLE
      },
      /**
       * Read channel records before presenting a local deletion. A marketplace record blocks
       * this action; confirmation does not authorize an implicit remote takedown.
       */
      preflight: async (rows) => {
        const [row] = rows
        if (!row) return { level: 'none', title: 'Nothing selected', unavailable: 'No row was selected' }
        let listings
        try {
          listings = await ops.listings(row.id)
        } catch (err) {
          // 🔴 A preflight that could not look must NOT fall back to a gentler confirm. The verb is
          // refused, and `runAction` enforces that rather than trusting this branch.
          return {
            level: 'none',
            title: `Delete ${row.sku}?`,
            unavailable: `Could not check what ${row.sku} is listed on: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
        const impact = classifyListings(listings)
        const live = impact.live.length
        if (live || listings.some(listing => listing.isPublished)) return { level: 'none', title: `Delete ${row.sku}?`, unavailable: 'This product still has a marketplace listing. Resolve that listing before deleting its local record.', findings: impact.verdicts.map(verdict => ({ rowId: row.id, label: verdict.label, severity: 'error' as const })) }
        return {
          // Severity decided by FACT, not by a flag someone set once.
          level: 'confirm',
          title: `Delete ${row.sku}?`,
          // Only what the operator ASKED for. The per-listing verdicts go to `findings`, which the
          // dialog renders under its own heading — filling both printed every listing twice.
          consequences: [
            `${row.sku} is deleted permanently — there is no undo and no trash`,
            ...(impact.verdicts.length === 0 ? ['It is not listed on any channel'] : []),
          ],
          sideEffects: [
            'Its channel listings are deleted with it, by database cascade',
            `Its entry is removed from ${family?.self.sku ?? 'the parent'}'s own listing payload, so the next publish does not reference it`,
          ],
          findings: impact.verdicts.map((v) => ({
            rowId: row.id,
            label: v.label,
            severity: v.risk === 'live' ? ('error' as const) : ('info' as const),
          })),
          // Keep the reviewed identity stable until execution.
          payload: { parentId: row.parentId, childId: row.id, sku: row.sku },
        }
      },
      run: async (rows, impact) => {
        const p = (impact?.payload ?? {}) as { parentId?: string; childId?: string; sku?: string }
        const parentId = p.parentId ?? rows[0]?.parentId
        const childId = p.childId ?? rows[0]?.id
        if (!parentId || !childId) return { ok: false, message: 'No child to delete' }
        const res = await ops.deleteVariant(parentId, childId)
        return { ok: !!res?.success, invalidates: { kind: 'page' } } satisfies ActionResult
      },
    },

    /**
     * DEMOTE PARENT — F3. Context verb: the subject is the product the studio is open on.
     *
     * A parent with children requires its SKU and the exact reviewed child IDs. The server
     * rejects changed membership before detaching children and demoting in one transaction.
     */
    {
      id: 'demote',
      label: 'Demote…',
      scope: contextOf('product-family'),
      danger: true,
      available: () => {
        if (!family) return disabled('Loading the family…')
        if (role !== 'parent') return disabled('Only a parent can be demoted')
        if (!can(PERM_PIM)) return needs(PERM_PIM, 'Demoting')
        return AVAILABLE
      },
      preflight: async () => {
        const children = family?.children ?? []
        const n = children.length
        return {
          // A childless parent loses nothing: this is the reversible case, and promote undoes it.
          level: n > 0 ? 'type-to-confirm' : 'confirm',
          title: n > 0
            ? `Demote ${family?.self.sku} and detach ${plural(n, 'child')}?`
            : `Demote ${family?.self.sku}?`,
          consequences: n > 0
            ? children.map((c) => `${c.sku} stops being a child and becomes a standalone product`)
            : [`${family?.self.sku} stops being a parent. It has no children, so nothing else changes.`],
          sideEffects: [
            'The variation theme is cleared',
            ...(n > 0
              ? ['The children are NOT deleted — they survive as standalone products, and can be re-attached']
              : ['Promoting it again reverses this']),
          ],
          confirmPhrase: n > 0 ? family?.self.sku : undefined,
          payload: { productId: family?.self.id, force: n > 0, expectedChildIds: children.map(child => child.id) },
        }
      },
      run: async (_rows, impact) => {
        const p = (impact?.payload ?? {}) as { productId?: string; force?: boolean; expectedChildIds?: string[] }
        if (!p.productId) return { ok: false, message: 'No product to demote' }
        // `force` comes from the approved snapshot, never re-derived: re-reading the child count
        // here could send force:true for a confirmation that described a childless demote.
        const res = await ops.demoteParent(p.productId, p.force, p.expectedChildIds)
        return { ok: res.success, invalidates: { kind: 'page' } } satisfies ActionResult
      },
    },
  ]
}
