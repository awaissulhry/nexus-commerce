'use client'

/**
 * The Fix window (Listing readiness rebuild, 2026-10-23 — docs/listings/READINESS-REBUILD-2026-10-23.md §2): one
 * product or family on one destination, in a centred DS `Modal`. What its state is, which problems keep it there in the
 * API's order, the listings each one touches, and a link that opens the exact field in the studio. The row's other
 * destinations are buttons under the title, so the operator moves between markets without closing.
 *
 * It only reads (`GET /api/catalog-transfer/readiness/detail`). Words and links are in `fixDialogModel.ts` — not
 * `fixDialog.ts`, which macOS (case-insensitive) takes for this file and TypeScript then drops from the program.
 * Readiness labels and tones come from `readinessMeta(state, 'scope')` only. The Modal moves the focus in on open and
 * back to the opener on close.
 */
import { Fragment, useEffect, useId, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import type { ReadinessDestination, ReadinessDetail, ReadinessProblem } from '@nexus/shared/listing-readiness'
import Link from '@/lib/workspaces/Link'
import { Button, Pill, Spinner, Tag } from '@/design-system/primitives'
import { AsOf, Banner, Disclosure, EmptyState, Modal } from '@/design-system/components'
import { SkuTag, readinessMeta } from '@/design-system/grid'
import { languageLabel } from '@/app/products/[id]/edit/_studio/scopes'
import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import {
  emptyWords, fixDetailPath, stateLine, fixTitle, inBusiness, listingTotal, listingWords, moreWords, problemKindLabel, productTitle,
  requiredByWords, stateParts,
} from './fixDialogModel'
import { destinationLines } from './marketChips'
import styles from './FixDialog.module.css'

export interface ReadinessFixDialogProps {
  open: boolean
  onClose: () => void
  /** The family root, or the single product. */
  productId: string
  /** The whole family (1) or only this product (0). */
  family: boolean
  /** The destination the window opens on. */
  destinationKey: string
  /** The row's destinations, in chip order: the switcher. */
  destinations: ReadinessDestination[]
  /** The page's filters (search, channel, market, …), passed on to the read. */
  query: Record<string, string>
  /** The row's name (or SKU) for the title. The read does not carry it. */
  productName?: string | null
}

type Read = { path: string; detail?: ReadinessDetail; error?: string }

export function ReadinessFixDialog({ open, onClose, productId, family, destinationKey, destinations, query, productName }: ReadinessFixDialogProps) {
  const [picked, setPicked] = useState<string | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Each opening starts on the destination it was opened for, and reads afresh.
  useEffect(() => { setPicked(null); if (!open) setRead(null) }, [open, destinationKey])

  const key = picked ?? destinationKey
  const path = open ? fixDetailPath(query, { productId, family, destinationKey: key }) : null
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void transferApi<ReadinessDetail>(path, undefined, controller.signal)
      .then((detail) => { if (!controller.signal.aborted) setRead({ path, detail }) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setRead({ path, error: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [path, attempt])

  // Only the answer to THIS read is shown: a previous product's or market's never stands in for it.
  const current = read && read.path === path ? read : null
  const detail = current?.detail ?? null
  const destinationLabel = detail?.destination.label ?? destinations.find((d) => d.key === key)?.label ?? 'Unknown destination'
  const title = fixTitle(productTitle(productName, detail, family), destinationLabel)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={title}
      subtitle={detail ? <Summary detail={detail} /> : undefined}
      subheader={destinations.length > 1 ? (
        // The grid's own lines: a store's markets under its short name; Shared and the market-less stores first.
        <div className={styles.switcher} role="group" aria-label="Markets">
          {destinationLines(destinations).map((line) => {
            const buttons = line.items.map(({ destination, text }) => {
              const here = destination.key === key
              return (
                <Button key={destination.key} size="xs" active={here} aria-current={here ? 'true' : undefined} aria-label={destination.label} onClick={() => setPicked(destination.key)}>
                  {text}
                </Button>
              )
            })
            return line.label === null ? (
              <div key={line.key} className={styles.switchLine}>{buttons}</div>
            ) : (
              <Fragment key={line.key}>
                <span className={styles.switchStore} aria-hidden>{line.label}</span>
                <div className={styles.switchMarkets}>{buttons}</div>
              </Fragment>
            )
          })}
        </div>
      ) : undefined}
      initialFocus="dialog"
      busy={!current}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {detail && <Button asChild variant="primary"><Link href={inBusiness(detail.editorHref)}>Open in studio</Link></Button>}
      </>}
    >
      {!current ? (
        <div className={styles.loading}><Spinner /><span>Loading the problems…</span></div>
      ) : current.error != null ? (
        <Banner tone="danger" title="Could not load the problems" action={<Button size="sm" onClick={() => { setRead(null); setAttempt((n) => n + 1) }}>Try again</Button>}>
          {current.error}
        </Banner>
      ) : detail ? (
        <DetailBody detail={detail} destinationLabel={destinationLabel} />
      ) : null}
    </Modal>
  )
}

/** State, listings by state, and when it was checked. */
function Summary({ detail }: { detail: ReadinessDetail }) {
  const meta = readinessMeta(detail.state, 'scope')
  const parts = listingTotal(detail.counts) > 1 ? stateParts(detail.counts) : []
  return (
    <span className={styles.summary}>
      <Pill tone={meta.tone}>{meta.label}</Pill>
      {parts.length > 0 && <span>{stateLine(detail.counts)}</span>}
      <span>
        {detail.pending
          ? 'Checking… the list is from the last check'
          : detail.computedAt ? <>Checked <AsOf at={detail.computedAt} /></> : 'Not checked yet'}
      </span>
    </span>
  )
}

function DetailBody({ detail, destinationLabel }: { detail: ReadinessDetail; destinationLabel: string }) {
  const headingId = useId()
  const notSetUp = readinessMeta('absent', 'scope').label
  const empty = detail.problems.length === 0 && detail.notes.length === 0 ? emptyWords(detail.state, destinationLabel) : null
  return (
    <div className={styles.body}>
      {detail.languages.length > 1 && (
        <div className={styles.languages} role="group" aria-label="Languages">
          {detail.languages.map((language) => {
            const meta = readinessMeta(language.state, 'scope')
            return (
              <span key={language.locale} className={styles.language}>
                {languageLabel(language.locale)} <Pill tone={meta.tone}>{meta.label}</Pill>
              </span>
            )
          })}
        </div>
      )}

      {detail.problems.length > 0 && (
        <section aria-labelledby={headingId}>
          <h2 id={headingId} className={styles.heading}>
            {detail.problems.length.toLocaleString('en')} {detail.problems.length === 1 ? 'problem' : 'problems'}
          </h2>
          <ul className={styles.problems}>
            {detail.problems.map((problem, i) => <ProblemItem key={`${problem.field ?? ''}:${i}`} problem={problem} />)}
          </ul>
        </section>
      )}

      {detail.notes.length > 0 && (
        <Banner tone="neutral" title={notSetUp}>
          {detail.notes.length === 1
            ? detail.notes[0]
            : <ul className={styles.notes}>{detail.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        </Banner>
      )}

      {empty && (
        <EmptyState
          icon={detail.state === 'ready' ? <CheckCircle2 size={22} aria-hidden /> : undefined}
          title={empty.title}
          description={empty.description ?? undefined}
        />
      )}
    </div>
  )
}

function ProblemItem({ problem }: { problem: ReadinessProblem }) {
  const requiredBy = requiredByWords(problem.requiredBy)
  const languages = problem.languages.map(languageLabel).join(', ')
  const more = moreWords(problem.products.length, problem.productCount)
  const only = problem.productCount === 1 && problem.products.length === 1 ? problem.products[0] : null
  return (
    <li className={styles.problem}>
      <div className={styles.problemHead}>
        <span className={styles.problemLabel}>{problem.label}</span>
        <Tag>{problemKindLabel(problem.kind)}</Tag>
        {problem.href && (
          <span className={styles.open}>
            <Button asChild size="sm" aria-label={`Open field: ${problem.label}`}>
              <Link href={inBusiness(problem.href)}>Open field</Link>
            </Button>
          </span>
        )}
      </div>
      {problem.message && <p className={styles.message}>{problem.message}</p>}
      {(requiredBy || languages) && (
        <div className={styles.meta}>
          {requiredBy && <span>{requiredBy}</span>}
          {languages && <span>{languages}</span>}
        </div>
      )}
      {only ? (
        <div className={styles.meta}><span>{listingWords(1)} · <SkuTag>{only.sku}</SkuTag></span></div>
      ) : problem.productCount > 0 && (
        <Disclosure summary={listingWords(problem.productCount)}>
          <ul className={styles.skus}>
            {problem.products.map((product) => (
              <li key={product.id}>
                <SkuTag>{product.sku}</SkuTag>
                {product.name && <span className={styles.skuName}> {product.name}</span>}
              </li>
            ))}
            {more && <li className={styles.skuName}>{more}</li>}
          </ul>
        </Disclosure>
      )}
    </li>
  )
}
