'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, Inbox, Lock, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
// B-TH-261: a held "Start a project" names the missing right in words.
import { rightRef } from '../../../../../lib/i18n/rights'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { BomView, StyleView } from '../../api'
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import { draftOf, editableRevision, isRoutingBlocker, isWideTab, nextRevisionNumber, releaseHeld, releasedOf, revisionInView, startRevisionHeld, STATUS_TONE, stepRevision, tabsFor, VARIANTS_ANCHOR, type StyleTab } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'
import { StyleDialogs } from './Dialogs'
import { OverviewTab } from './OverviewTab'
import { PrepacksSection } from '../prepacks/view/PrepacksSection'
import { ProtectorsSection } from '../protectors/view/ProtectorsSection'
// B-W2b-241: the BOM tab's problem mark from THE check.
import { bomMarkCount } from '../../bom/depth/model'
// B-W2b-236: Overview & variants › Sketches and pictures; Patterns › Pattern files.
import { GallerySection } from '../gallery/view/GallerySection'
import { PatternFilesSection } from '../files-w2b/view/PatternFilesSection'
// B-W2b-240: Sizes & measurements › Measurement spec.
import { SpecSection } from '../spec/view/SpecSection'
import { TabBody } from './TabBody'
// B-W2b-245: Versions & changes, Compare revisions, and the Release modal on B-W2b-231's gate.
import { VersionsTab } from '../../versions/view/VersionsTab'
import { CompareDialog } from '../../versions/view/CompareDialog'
import { ReleaseGateDialog } from '../../release/view/ReleaseGateDialog'
import { VariantsTab } from './VariantsTab'
// B-W2b-237: the depth's parts at their places (identity, side panel, the matrix's GTINs).
import type { StyleDepthSlots } from '../overview/slots'
// ---- B-TH-261: the style on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import '../../styles.css'

export type { StyleRecordViewModel, StyleRecordActions } from '../record-model'

/**
 * SCR-041 … SCR-045 — the Style studio (design products.styles "Record: Style"; Owner L1: the tabs always in view), on RecordFrame
 * (B-TH-261; the rule of picture 38, the tabs of picture 39 / 08-tabs O-PRD-STY): the band in the shell's band row — ‹ Styles,
 * "<code> · <name>", ONE pill (the lifecycle), the revision in view (a scope picker: `[` / `]` step through the revisions), the
 * released one, the PPE tag, what the draft lacks, "Made from INQ-… — Open" for a draft a request made and the save words as the
 * band's details; the next step as the primary — Release revision N, held with the count of what blocks it (`r` opens the check
 * anyway) — the Thread button (⌘J) and ⋯ (Start revision N, Abandon the draft, Archive / Reactivate, Duplicate, the tech pack, the
 * samples, options and changes, Compare revisions, Copy code; the frame's ONE Keyboard line lists the page's keys too). The style's
 * thread is docked beside every tab (40 %; one third on the wide grids under 1600 px): a private-label style's with its brand only,
 * our own collection's notes only; Activity's tools are in the thread's "⋯" (R-ACT), loose files in its Files view. Tabs 11 → 9:
 * Overview & variants, Sizes & measurements, Materials (BOM), Operations, Cost, Tech pack, Compliance, Patterns, Versions & changes —
 * each shown only to a person whose role reads it. ONE notice in the body column. A released revision is frozen: its tabs say so and
 * offer the draft (or Start revision N). It draws one view model and fetches nothing (StyleRecord.tsx loads it).
 */
// B-TH-261: `thread` is the docked thread (the office's OfficeRecordThread docked, or a design case's; null: none for this person),
// `printThread` what the print view shows of it (the record panels' print form).
export function StyleRecordView({
  model,
  actions,
  thread,
  printThread,
  techPack,
  depth,
  costSheets,
}: {
  model: StyleRecordViewModel
  actions?: StyleRecordActions
  thread?: ReactNode
  printThread?: ReactNode
  /** B-W2b-243: the Tech pack tab's body (the container mounts it while the tab is open). */
  techPack?: ReactNode
  /** B-W2b-237: the depth's parts (the container builds them from one model). */
  depth?: StyleDepthSlots
  /** B-W2b-430: the Cost tab's cost sheets (W2b steps, versions and approval, target price, cost by size), after W1's sheet. */
  costSheets?: ReactNode
}) {
  return (
    <WithMessages namespaces={['products', 'records', 'lists', 'products-prepacks', /* B-W2b-243 */ 'products-techpack', /* B-W2b-261 */ 'products-samples', /* B-W2b-242 */ 'products-options', /* B-W2b-244 */ 'products-changes', /* B-W2b-237 */ 'products-styles-depth', /* B-W2b-245 */ 'products-versions', /* B-W2b-283 */ 'products-followups-w2b4']}>
      <StyleRecord model={model} actions={actions} thread={thread} printThread={printThread} techPack={techPack} depth={depth} costSheets={costSheets} />
    </WithMessages>
  )
}

interface BodyProps {
  model: StyleRecordViewModel
  actions?: StyleRecordActions
  thread?: ReactNode
  printThread?: ReactNode
  techPack?: ReactNode
  depth?: StyleDepthSlots
  costSheets?: ReactNode
}

function StyleRecord({ model, actions, thread, printThread, techPack, depth, costSheets }: BodyProps) {
  const t = useT('products')
  const listHref = `${model.prefix}/products/styles`
  const loaded = model.style

  // B-TH-261: the page's states before the style is read (loading, not found, failed, no access) sit in the frame with the way back
  // and no thread.
  if (loaded.status !== 'ready') {
    return (
      <RecordFrame
        recordType="Style"
        personId={model.personId ?? null}
        band={{ back: <Link href={listHref}>{t('record.back')}</Link>, title: loaded.status === 'loading' ? <Skeleton width={240} height={22} /> : t('record.title'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        <div className="fw-st">
          {loaded.status === 'loading' ? (
            <Card padded aria-busy="true">
              <p className="fw-st-hint" role="status">
                <Spinner size={14} /> {t('record.loading')}
              </p>
              <div className="fw-st-skeleton">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} height={22} />
                ))}
              </div>
            </Card>
          ) : (
            <Card padded>
              <EmptyState
                icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
                title={t(`record.state.${loaded.status}.title`)}
                description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
                action={
                  loaded.status === 'error' ? (
                    <Button size="sm" onClick={() => actions?.onRetry?.()}>
                      {t('common.retry')}
                    </Button>
                  ) : (
                    <Button size="sm" asChild>
                      <Link href={listHref}>{t('record.backToList')}</Link>
                    </Button>
                  )
                }
              />
            </Card>
          )}
        </div>
      </RecordFrame>
    )
  }
  return <ReadyRecord style={loaded.value} model={model} actions={actions} thread={thread} printThread={printThread} techPack={techPack} depth={depth} costSheets={costSheets} />
}

function ReadyRecord({ style, model, actions, thread, printThread, techPack, depth, costSheets }: BodyProps & { style: StyleView }) {
  const t = useT('products')
  // B-W2b-243: the band's ⋯ "Make tech pack PDF…" (it opens the Tech pack tab with its dialog).
  const tt = useT('products-techpack')
  // B-W2b-261: the band's links to the style's sample rounds.
  const ts = useT('products-samples')
  // B-W2b-242: the band's link to the style's options (Options & rules: its option BOM lines and routing steps).
  const tOptions = useT('products-options')
  // B-W2b-244: the band's links to the style's changes.
  const tc = useT('products-changes')
  // B-W2b-245: the band's "Compare revisions…".
  const tv = useT('products-versions')
  const locale = useLocale()
  const recordHref = `${model.prefix}/products/styles/${style.id}`
  const revision = revisionInView(style.revisions, model.revisionId)
  const draft = draftOf(style.revisions)
  const released = releasedOf(style.revisions)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  const held = releaseHeld(style, revision, bom, model.can)
  const startHeld = startRevisionHeld(style, model.can)
  const next = nextRevisionNumber(style.revisions)
  const tabs = tabsFor(model.can)
  const tab: StyleTab = tabs.includes(model.tab) ? model.tab : 'overview'
  const tabHref = (to: StyleTab) => `${recordHref}?tab=${to}${model.revisionId ? `&rev=${model.revisionId}` : ''}`

  // Keys (00 §3.17 + the page's own): r the release check, [ ] the revisions — never while typing. ⌘J is the frame's (the thread);
  // the page's keys are listed in the band menu's ONE Keyboard line (PR-14: no "?" overlay).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (!!target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)
      const inDialog = !!target?.closest('[role="dialog"]')
      if (typing || inDialog || model.dialog || model.duplicate || model.bomImport || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'r' && revision?.status === 'DRAFT') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'release' })
      } else if (event.key === '[' || event.key === ']') {
        const to = stepRevision(style.revisions, revision?.id ?? null, event.key === '[' ? -1 : 1)
        if (to) {
          event.preventDefault()
          actions?.onRevision?.(to.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const issueCount = bom && revision?.status === 'DRAFT' ? bom.issues.length : 0
  // B-W2b-241: the BOM tab's mark counts THE check (the structure's findings too) once it is read; W1's issues until then.
  const bomMark = bomMarkCount(model.bomDepth?.structure.status === 'ready' ? model.bomDepth.structure.value : null)
  const markOf = (which: 'bom' | 'routing') => (which === 'bom' && bomMark !== null ? bomMark : issueCount > 0 ? countFor(which, bom) : 0)
  const tabItems: TabItem[] = tabs.map((item) => ({
    id: item,
    href: tabHref(item),
    label:
      (item === 'bom' || item === 'routing') && markOf(item) > 0 ? (
        <span className="fw-st-tablabel">
          {t(`tab.${item}`)}
          <span className="fw-st-dot" aria-label={t('tab.problems', { count: markOf(item) })} role="img" />
        </span>
      ) : (
        t(`tab.${item}`)
      ),
    // B-TH-261: Overview & variants counts the SKUs (as Colourways & sizes did); Patterns its pattern pieces.
    count: item === 'overview' ? style.skuCount : item === 'bom' && bom ? bom.lines.length : item === 'patterns' && model.pieces?.part.status === 'ready' ? model.pieces.part.value.pieces.length : null,
  }))

  const primary =
    revision && revision.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'release' })} aria-keyshortcuts="r">
        {t('action.release', { revision: revision.revision })}
      </Button>
    ) : (
      <Button size="sm" variant={revision ? 'secondary' : 'primary'} heldReason={startHeld ? t(startHeld, { revision: draft?.revision ?? next }) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'startRevision' })}>
        {t('action.startRevision', { revision: next })}
      </Button>
    )

  const more: MenuItemDef[] = [
    ...(revision?.status === 'DRAFT' && draft
      ? [{ id: 'abandon', label: t('action.abandon', { revision: draft.revision }), disabled: !model.can.bomManage, description: model.can.bomManage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'abandon' }) }]
      : []),
    ...(revision && revision.status !== 'DRAFT' && !startHeld ? [{ id: 'start', label: t('action.startRevision', { revision: next }), onSelect: () => actions?.onDialog?.({ kind: 'startRevision' }) }] : []),
    { id: 'duplicate', label: t('action.duplicate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDuplicate?.() },
    // B-W2b-243 (design pop:styles.techpackPdf "Tech pack tab · band overflow").
    ...(tabs.includes('techpack') && revision ? [{ id: 'techpack', label: tt('techpack.band.make'), href: `${tabHref('techpack')}&make=1` }] : []),
    // B-W2b-261 (design products.styles conn "Samples & prototypes (rounds pinned to a revision)"; pop:samples.new "Style record").
    ...(model.samples?.view
      ? [{ id: 'samples', label: revision ? ts('style.rounds', { revision: revision.revision }) : ts('style.roundsAll'), href: `${model.prefix}/products/samples?style=${encodeURIComponent(style.id)}${revision ? `&revision=${encodeURIComponent(revision.id)}` : ''}` }]
      : []),
    ...(model.samples?.manage ? [{ id: 'sampleNew', label: ts('style.newRequest'), href: `${model.prefix}/products/samples?new=1&style=${encodeURIComponent(style.id)}${revision && revision.status !== 'OBSOLETE' ? `&revision=${encodeURIComponent(revision.id)}` : ''}` }] : []),
    // B-W2b-242 (design products.styles conn "Options & rules (option-dependent lines, W2b)").
    { id: 'options', label: tOptions('style.link'), href: `${model.prefix}/products/options?style=${encodeURIComponent(style.id)}` },
    // B-W2b-244 (design products.styles conn "Changes & versions"; pop:changes.new "Style › Versions & changes").
    ...(model.changes?.view ? [{ id: 'changes', label: tc('style.changes'), href: `${model.prefix}/products/changes?style=${encodeURIComponent(style.id)}` }] : []),
    ...(model.changes?.request ? [{ id: 'changeNew', label: tc('style.newRequest'), href: `${model.prefix}/products/changes?new=1&style=${encodeURIComponent(style.id)}` }] : []),
    // B-W2b-245 (design pop:styles.compare "Versions tab · band overflow").
    ...(model.versions && style.revisions.length > 1 ? [{ id: 'compare', label: tv('cmp.open'), onSelect: () => actions?.versions?.onCompareOpen?.() }] : []),
    // B-TH-261 (TH-5's Projects, #1582): a new project with this style linked; a private-label style's project is its brand's (a
    // project never mixes customers), our own collection's an office project.
    ...(model.projects?.view
      ? [
          {
            id: 'project',
            label: t('action.startProject'),
            href: model.projects.manage ? `${model.prefix}/products/projects?new=1&link=${encodeURIComponent(`Style:${style.id}`)}&linkLabel=${encodeURIComponent(style.code)}${style.brand ? `&party=${encodeURIComponent(style.brand.id)}` : ''}` : undefined,
            disabled: !model.projects.manage,
            description: model.projects.manage ? undefined : t('held.noProjects', { right: rightRef('projects.manage') }),
          },
        ]
      : []),
    {
      id: 'copy',
      label: t('action.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(style.code).catch(() => undefined)
      },
    },
    // B-TH-261: the destructive lines last (band-F03: danger items last and red, never next to the primary).
    ...(style.status === 'ARCHIVED'
      ? [{ id: 'reactivate', label: t('action.reactivate'), disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }]
      : [{ id: 'archive', label: t('action.archive'), tone: 'danger' as const, disabled: !model.can.manage, description: model.can.manage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'archive' }) }]),
  ]

  // B-TH-261 (PR-14): the page's own keys, listed first in the band menu's ONE Keyboard line (⌘J and the thread's keys follow).
  const keys = PAGE_KEYS.map((entry) => ({ keys: entry.keys, label: t(entry.does) }))

  const saveWords =
    model.save.state === 'saving' ? (
      <span className="fw-st-save" role="status">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    ) : model.save.state === 'failed' ? (
      <span className="fw-st-save is-failed" role="status">
        {t('save.failed')}
      </span>
    ) : model.save.at ? (
      <span className="fw-st-save" role="status">
        {t('save.saved', { time: formatTime(model.save.at, { locale }) })}
      </span>
    ) : (
      <span className="fw-st-save" role="status" />
    )

  const frozenTab = (tab === 'bom' || tab === 'routing' || tab === 'compliance' || tab === 'patterns') && revision && !editableRevision(style, revision)
  const ppe = style.ppeCategory !== 'NOT_PPE'
  const madeFrom = model.madeFrom ?? null

  return (
    <>
      <RecordFrame
        recordType="Style"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        wide={isWideTab(tab)}
        band={{
          back: <Link href={`${model.prefix}/products/styles`}>{t('record.back')}</Link>,
          title: (
            <span className="fw-st-title">
              {style.code} <span className="fw-st-title-name">· {style.name}</span>
            </span>
          ),
          status: <Pill tone={STATUS_TONE[style.status]}>{t(`status.${style.status}`)}</Pill>,
          meta: (
            <span className="fw-st-meta">
              {style.revisions.length > 0 ? (
                <label className="fw-st-scope">
                  <span className="fw-st-hint">{t('record.viewing')}</span>
                  <Select size="sm" aria-label={t('record.revisionPicker')} value={revision?.id ?? ''} onChange={(event) => actions?.onRevision?.(event.target.value)}>
                    {[...style.revisions]
                      .sort((a, b) => b.revision - a.revision)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {t('record.revisionOption', { revision: entry.revision, status: t(`revisionStatus.${entry.status}`) })}
                        </option>
                      ))}
                  </Select>
                </label>
              ) : (
                <Tag tone="warning">{t('record.noRevision')}</Tag>
              )}
              {released && revision?.id !== released.id && <Tag tone="neutral">{t('record.releasedIs', { revision: released.revision })}</Tag>}
              {ppe ? <Tag tone="info">{[t(`ppe.short.${style.ppeCategory}`), style.ppeStandard, style.ppeClass].filter(Boolean).join(' · ')}</Tag> : <Tag tone="neutral">{t('ppe.short.NOT_PPE')}</Tag>}
              {revision?.status === 'DRAFT' && bom && (
                <Tag tone={bom.issues.length > 0 ? 'warning' : 'success'}>{bom.issues.length > 0 ? t('record.thingsBefore', { count: bom.issues.length }) : t('record.readyToRelease')}</Tag>
              )}
              {/* B-TH-261: "Made from INQ-… — Open" for a draft a request made (office only; read with sales.inquiries.view). */}
              {madeFrom && (
                <Link className="fw-st-link" href={`${model.prefix}/sales/incoming/${encodeURIComponent(madeFrom.inquiryId)}`}>
                  <Inbox size={12} aria-hidden /> {t('record.madeFrom', { number: madeFrom.number })}
                </Link>
              )}
              {saveWords}
            </span>
          ),
          primary,
          more,
          moreLabel: t('record.more'),
          keys,
        }}
      >
        <div className="fw-st">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tab} size="sm" overflow="scroll" />
          {/* B-TH-261: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            {model.notice && (
              <Banner
                tone={model.notice.tone}
                title={t(model.notice.key, model.notice.params)}
                action={
                  actions?.onDismissNotice ? (
                    <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                      {t('common.dismiss')}
                    </Button>
                  ) : undefined
                }
              />
            )}
            {model.changed && (
              <Banner
                tone="info"
                title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
                action={
                  <Button size="sm" onClick={() => actions?.onReload?.()}>
                    {t('record.reload')}
                  </Button>
                }
              />
            )}
            {style.status === 'ARCHIVED' && (
              <Banner
                tone="info"
                title={
                  <span className="fw-st-inline">
                    <Lock size={14} aria-hidden /> {t('record.archivedBanner')}
                  </span>
                }
              />
            )}
            {frozenTab && revision && (
              <Banner
                tone="info"
                title={
                  <span className="fw-st-inline">
                    <Lock size={14} aria-hidden /> {t(revision.status === 'RELEASED' ? 'record.frozenReleased' : 'record.frozenObsolete', { revision: revision.revision })}
                  </span>
                }
                action={
                  draft && draft.id !== revision.id ? (
                    <Button size="sm" onClick={() => actions?.onRevision?.(draft.id)}>
                      {t('record.goToDraft', { revision: draft.revision })}
                    </Button>
                  ) : !startHeld ? (
                    <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'startRevision' })}>
                      {t('action.startRevision', { revision: next })}
                    </Button>
                  ) : undefined
                }
              />
            )}
          </RecordNotices>

          {tab === 'overview' ? (
            // B-W2b-236 + B-TH-261: Overview & variants — the identity and its side, Sketches and pictures, then the size range, the
            // colourways and the SKU matrix (Colourways & sizes, merged here: every action kept).
            <div className="fw-st-stack-lg">
              <OverviewTab style={style} model={model} actions={actions} depth={depth /* B-W2b-237 */} />
              <GallerySection model={model.gallery} actions={actions?.gallery} />
              <section id={VARIANTS_ANCHOR} className="fw-st-variants" aria-label={t('record.variantsLabel')}>
                <VariantsTab style={style} model={model} actions={actions} depth={depth /* B-W2b-237 */} />
              </section>
            </div>
          ) : tab === 'patterns' ? (
            // B-W2b-236: Patterns' sections — Pattern files per revision and size range, then the pattern pieces.
            <div className="fw-st-stack-lg">
              <PatternFilesSection model={model.patternFiles} actions={actions?.patternFiles} />
              <TabBody tab={tab} style={style} model={model} actions={actions} />
            </div>
          ) : tab === 'sizes' ? (
            // B-W2b-233: the Sizes & measurements tab's sections, in the design's order (the Measurement spec joins with B-W2b-240).
            <div className="fw-st-stack-lg">
              {/* B-W2b-240: the Measurement spec, after the size range (Overview) and before the prepacks. */}
              {model.can.bomView && <SpecSection style={style} model={model} spec={model.spec} actions={actions?.spec} recordActions={actions} />}
              <PrepacksSection model={model} actions={actions?.prepacks} />
              {model.can.bomView && <ProtectorsSection style={style} model={model} actions={actions?.protectors} recordActions={actions} />}
            </div>
          ) : tab === 'versions' && model.versions ? (
            // B-W2b-245: Versions & changes (revisions, Compare revisions, change requests and orders, orders on older revisions).
            <VersionsTab style={style} model={model.versions} record={model} actions={actions?.versions} recordActions={actions} />
          ) : tab === 'techpack' ? (
            // B-W2b-243: the Tech pack tab (SCR-305), mounted by the container.
            (techPack ?? null)
          ) : tab === 'cost' && costSheets ? (
            // B-W2b-430: the Cost tab's sections — W1's sheet, then the cost sheets of W2b (design order: steps, versions, target price, by size).
            <div className="fw-st-stack-lg">
              <TabBody tab={tab} style={style} model={model} actions={actions} />
              {costSheets}
            </div>
          ) : (
            <TabBody tab={tab} style={style} model={model} actions={actions} />
          )}
        </div>
      </RecordFrame>

      <StyleDialogs style={style} model={model} actions={actions} />
      {/* B-W2b-245: the Release modal on the gate (it replaces W1's check while open) and Compare revisions. */}
      {model.release && <ReleaseGateDialog style={style} model={model.release} bom={bom} routing={model.routing.status === 'ready' ? model.routing.value : null} prefix={model.prefix} can={model.can} busy={model.busy} actions={actions?.release} />}
      {model.versions?.compareOpen && <CompareDialog model={model.versions} actions={actions?.versions} />}
      {model.duplicate && <DuplicateDialog model={model.duplicate} can={model.can} prefix={model.prefix} actions={actions?.duplicate} />}
    </>
  )
}

/** The problem dot of a tab: the release check's findings that belong to it. */
function countFor(tab: 'bom' | 'routing', bom: BomView | null): number {
  if (!bom) return 0
  return bom.issues.filter((issue) => (tab === 'routing' ? isRoutingBlocker(issue.code) : !isRoutingBlocker(issue.code) && issue.code !== 'NO_SIZE_RANGE' && issue.code !== 'NO_ACTIVE_COLOURWAY')).length
}

// B-TH-261 (PR-14): the page's own keys, in the band menu's ONE Keyboard line (the frame adds ⌘J and the thread's keys).
const PAGE_KEYS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { keys: ['r'], does: 'keys.release' },
  { keys: ['['], does: 'keys.prevRevision' },
  { keys: [']'], does: 'keys.nextRevision' },
  { keys: ['⌘', 'S'], does: 'keys.save' },
  { keys: ['n'], does: 'keys.add' },
  { keys: ['v'], does: 'keys.bomView' },
  { keys: ['Space'], does: 'keys.skuCell' },
  { keys: ['⇧', 'Space'], does: 'keys.skuRow' },
  { keys: ['Alt', '↑'], does: 'keys.moveUp' },
  { keys: ['Alt', '↓'], does: 'keys.moveDown' },
]
