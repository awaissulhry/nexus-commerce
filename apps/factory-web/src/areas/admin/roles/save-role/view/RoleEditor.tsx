'use client'

import { Banner, Card, Disclosure, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar, ReviewChangesModal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Grain, PermissionCatalogue, Role } from '../../../shared/api'
import { GRAINS } from '../../../shared/model'
import { byArea, permissionKey, type MatrixPermission } from '../../../shared/view/PermissionMatrix'
import { useRoleWords } from '../../../shared/view/parts'
import { draftDiff, editablePermissions, grainToggled, refusalWords, reviewRows, toggled, type RoleDraft, type RoleReview } from '../model'
import '../roles-depth.css'

/** The review pop-up (pop:save-role): reading, ready, saving, saved, or the read failed. */
export type SaveReview =
  | { phase: 'reading' }
  | { phase: 'failed'; problem: string }
  | { phase: 'ready'; review: RoleReview; problem: string | null; paths: readonly string[] }
  | { phase: 'saving'; review: RoleReview }
  | { phase: 'done'; review: RoleReview }

export interface RoleEditorModel {
  role: Role
  catalogue: PermissionCatalogue
  draft: RoleDraft
  review: SaveReview | null
}

export interface RoleEditorActions {
  onDraft?: (draft: RoleDraft) => void
  onDiscard?: () => void
  /** EditModeBar's Save: open the review (POST …/review). */
  onReview?: () => void
  /** The review's Save role (a fresh code first when it asks one). */
  onSave?: () => void
  onCloseReview?: () => void
  onRetryReview?: () => void
}

/**
 * Admin › Roles › a custom role › Permissions › Every permission, editable (SCR-012, B-W2b-413; PLT-031): the money sight as
 * toggles with what disappears without each, then every permission by area with its risk mark as a tick; EditModeBar → the
 * ReviewChangesModal "Change role '<name>'?" (adds · removes · grains · how many people get it at their next request; a raise
 * needs the acknowledgement and a fresh code). The DS PermissionMatrix part is not in the DS yet: composed here from DS
 * Disclosure, SummaryTable, Checkbox, Toggle (as the read-only shared/view/PermissionMatrix). Fetches nothing.
 */
export function RoleEditor({ model, actions }: { model: RoleEditorModel; actions?: RoleEditorActions }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

function Editor({ model, actions }: { model: RoleEditorModel; actions?: RoleEditorActions }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const words = useRoleWords()
  const { role, draft } = model
  const permissions = editablePermissions(model.catalogue)
  const groups = byArea(permissions)
  const held = new Set(draft.permissions)
  const diff = draftDiff(role, draft)
  const permissionWords = (permission: MatrixPermission) => {
    const key = permissionKey(permission.name)
    const text = ta(key)
    return text === key ? permission.description : text
  }
  const areaWords = (area: string) => (ta(`area.${area}`) === `area.${area}` ? area : ta(`area.${area}`))
  return (
    <Card header={ta('role.every')} description={t('saveRole.hint')} headingLevel={2} padded>
      <div className="fw-rol-edit">
        <section aria-labelledby="fw-rol-money" className="fw-rol-edit-block">
          <h3 id="fw-rol-money" className="fw-rol-sub">
            {t('saveRole.money')}
          </h3>
          <ul className="fw-rol-grains">
            {GRAINS.map((grain) => {
              const on = draft.grains.includes(grain)
              return (
                <li key={grain} className="fw-rol-grain">
                  <span className="fw-rol-grain-head">
                    <Toggle size="sm" checked={on} aria-label={t('saveRole.grainToggle', { grain: ta(`grains.short.${grain}`) })} onChange={(next) => actions?.onDraft?.(grainToggled(draft, grain, next))} />
                    <span className="fw-adm-name">{t('saveRole.sees', { grain: ta(`grains.short.${grain}`) })}</span>
                  </span>
                  {!on && <span className="fw-adm-hint">{ta(`grains.without.${grain}`)}</span>}
                </li>
              )
            })}
          </ul>
          {!role.requireMfa && draft.grains.some((grain) => grain === 'cost' || grain === 'margin') && <p className="fw-adm-hint">{t('saveRole.mfaWhy')}</p>}
        </section>
        <div className="fw-adm-matrix">
          {groups.map((group) => {
            const count = group.permissions.filter((permission) => held.has(permission.name)).length
            const area = areaWords(group.area)
            return (
              <Disclosure
                key={group.area}
                open={count > 0}
                summary={
                  <span className="fw-adm-matrix-summary">
                    <span className="fw-adm-matrix-area">{area}</span>
                    <span className="fw-adm-hint">{ta('matrix.count', { count, total: group.permissions.length })}</span>
                  </span>
                }
              >
                <SummaryTable
                  label={ta('matrix.tableLabel', { area })}
                  columns={[ta('matrix.permission'), t('saveRole.allowed')]}
                  widths={['78%']}
                  stackOnPhone
                  rows={group.permissions.map((permission) => {
                    const name = permissionWords(permission)
                    const was = role.permissions.includes(permission.name)
                    const on = held.has(permission.name)
                    return {
                      id: permission.name,
                      cells: [
                        <span key="name" className="fw-adm-matrix-row">
                          <span>{name}</span>
                          <span className="fw-adm-matrix-marks">
                            {permission.risk === 'stepUp' && <Tag tone="warning">{ta('matrix.risk.stepUp')}</Tag>}
                            {was !== on && <Tag tone="info">{t(on ? 'saveRole.adding' : 'saveRole.removing')}</Tag>}
                          </span>
                        </span>,
                        <Checkbox key="tick" checked={on} aria-label={t('saveRole.tick', { permission: name })} onChange={(event) => actions?.onDraft?.(toggled(draft, permission.name, event.target.checked))} />,
                      ],
                    }
                  })}
                />
              </Disclosure>
            )
          })}
        </div>
        {diff.count > 0 ? (
          <EditModeBar count={diff.count} onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onReview?.()} applyLabel={t('saveRole.reviewSave')} saveShortcut />
        ) : (
          <p className="fw-adm-hint">{t('saveRole.atRest')}</p>
        )}
      </div>
      {model.review && <Review model={model} review={model.review} roleName={words.name(role)} actions={actions} />}
    </Card>
  )
}

/** pop:save-role — the DS ReviewChangesModal over the API's review. */
function Review({ model, review, roleName, actions }: { model: RoleEditorModel; review: SaveReview; roleName: string; actions?: RoleEditorActions }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const catalogue = model.catalogue.permissions
  const permission = (name: string) => {
    const key = permissionKey(name)
    const text = ta(key)
    return text === key ? (catalogue.find((item) => item.name === name)?.description ?? name) : text
  }
  const grain = (value: Grain) => t('saveRole.sees', { grain: ta(`grains.short.${value}`) })
  const answer = review.phase === 'reading' || review.phase === 'failed' ? null : review.review
  const rows = answer ? reviewRows(answer, { permission, grain, risky: (name) => catalogue.find((item) => item.name === name)?.risk === 'stepUp', t }) : []
  const refusals = review.phase === 'ready' ? [...(answer?.refusals.map((item) => item.path) ?? []), ...review.paths] : []
  const problems = [...new Set(refusals)].map((path) => {
    const words = refusalWords(path)
    return t(words.key, { permission: words.subject?.permission ? permission(words.subject.permission) : '', grain: words.subject?.grain ? ta(`grains.short.${words.subject.grain}`) : '' })
  })
  const state =
    review.phase === 'reading'
      ? ({ phase: 'reading' } as const)
      : review.phase === 'failed'
        ? ({ phase: 'failed', error: ta(review.problem) } as const)
        : review.phase === 'saving'
          ? ({ phase: 'saving' } as const)
          : review.phase === 'done'
            ? ({ phase: 'done', results: Object.fromEntries(rows.map((row) => [row.id, { ok: true, words: t('saveRole.saved') }])) } as const)
            : ({ phase: 'ready' } as const)
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.onCloseReview?.()}
      title={t('saveRole.title', { name: roleName })}
      summary={
        answer ? (
          <span>
            {t('saveRole.holders', { count: answer.holders })}
            {answer.asksFreshCode ? ` ${t('saveRole.asksCode')}` : ` ${t('saveRole.noCode')}`}
          </span>
        ) : undefined
      }
      changes={rows.map((row) => ({ id: row.id, what: row.what, now: row.now, next: row.next, raise: row.raise, ...(row.note ? { note: row.note } : {}) }))}
      state={state}
      problems={[...problems, ...(review.phase === 'ready' && review.problem ? [t(review.problem)] : [])]}
      saveLabel={t('saveRole.save')}
      ackLabel={t('saveRole.ack')}
      onSave={() => actions?.onSave?.()}
      onRetry={() => actions?.onRetryReview?.()}
      onDone={() => actions?.onCloseReview?.()}
      size="xl"
    />
  )
}

/** A custom role that cannot be changed here: why, above the read-only matrix. */
export function EditHeld({ reason }: { reason: string }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <HeldBanner reason={reason} />
    </WithMessages>
  )
}

function HeldBanner({ reason }: { reason: string }) {
  const t = useT('admin-security-depth')
  return <Banner tone="info" title={t(reason)} />
}

/** A receipt or refusal of Change role, Archive or Restore (a message key of `admin-security-depth`). */
export function DepthNotice({ notice, onDismiss }: { notice: { key: string; tone: 'success' | 'warning' }; onDismiss?: () => void }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <NoticeLine notice={notice} onDismiss={onDismiss} />
    </WithMessages>
  )
}

function NoticeLine({ notice, onDismiss }: { notice: { key: string; tone: 'success' | 'warning' }; onDismiss?: () => void }) {
  const t = useT('admin-security-depth')
  return <Banner tone={notice.tone} title={t(notice.key)} onDismiss={onDismiss} />
}

/** "Archive…" / "Restore" for a custom role (roles.manage), in the record's band. */
export function ArchiveButtons({ role, held, onArchive, onRestore }: { role: Role; held: string | null; onArchive?: () => void; onRestore?: () => void }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Archive role={role} held={held} onArchive={onArchive} onRestore={onRestore} />
    </WithMessages>
  )
}

function Archive({ role, held, onArchive, onRestore }: { role: Role; held: string | null; onArchive?: () => void; onRestore?: () => void }) {
  const t = useT('admin-security-depth')
  if (role.system) return null
  return role.archivedAt ? (
    <Button size="sm" heldReason={held ? t(held) : null} onClick={() => onRestore?.()}>
      {t('archive.restore')}
    </Button>
  ) : (
    <Button size="sm" variant="danger-outline" heldReason={held ? t(held) : null} onClick={() => onArchive?.()}>
      {t('archive.button')}
    </Button>
  )
}
