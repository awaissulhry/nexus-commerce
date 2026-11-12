'use client'

import { Banner, Card } from '@nexus/ui/components'
import { Button, CheckboxCard, Kbd, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../../lib/i18n/provider'
import type { MarketChoice, StyleMarketsView } from '../api'
import { marketMarks, marketName, marketsHeld, NS, pickChoices, saveHeld, type MarketsActions, type MarketsModel } from '../model'
import '../markets.css'

/**
 * SCR-342 — the Overview's "Markets" (B-W2b-283, FU1:01; design products.styles rec:Style › Overview "Markets: a pick of the
 * company's market profiles"; the status board's "set markets on the style"): where the style is sold, as a list of the
 * market profiles (none picked: every market), what that means at the gates in words, and the pick (a pop-up of the
 * company's markets and every company's, each with the languages the gates ask there). Draws one model; fetches nothing.
 */
export function MarketsCard({ model, actions }: { model: MarketsModel; actions?: MarketsActions }) {
  // `w`, not `t`: the depth's own key test reads every t('…') under overview/ as a products-styles-depth key.
  const w = useT(NS)
  const held = marketsHeld(model)
  const view = model.part.status === 'ready' ? model.part.value : null
  return (
    <Card
      header={w('markets.title')}
      description={w('markets.intro')}
      headerAction={
        <Button size="sm" heldReason={held ? w(held) : null} onClick={() => actions?.onOpen?.()}>
          {w('markets.change')}
        </Button>
      }
    >
      <div className="fw-st-stack">
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={w(model.notice.key, model.notice.params)}
            action={
              actions?.onDismissNotice ? (
                <Button size="sm" variant="quiet" onClick={() => actions.onDismissNotice?.()}>
                  {w('markets.dismiss')}
                </Button>
              ) : undefined
            }
          />
        )}
        {model.part.status === 'ready' ? (
          <MarketsBody view={model.part.value} />
        ) : model.part.status === 'error' ? (
          <div className="fw-st-stack" role="status">
            <p className="fw-st-hint">{w(model.part.problem)}</p>
            {actions?.onRetry && (
              <span>
                <Button size="sm" onClick={() => actions.onRetry?.()}>
                  {w('markets.retry')}
                </Button>
              </span>
            )}
          </div>
        ) : (
          <div className="fw-st-stack" aria-busy="true">
            <span className="fw-sdp-sr" role="status">
              {w('markets.loading')}
            </span>
            <Skeleton height={18} />
            <Skeleton height={18} />
          </div>
        )}
        {view && view.refusal && view.mayChange && <p className="fw-st-hint">{w(held ?? 'markets.refusal.other')}</p>}
        {view && !view.mayChange && <p className="fw-st-hint">{w('markets.readOnly')}</p>}
      </div>
      {model.pick && view && <MarketsPick model={model} view={view} actions={actions} />}
    </Card>
  )
}

function MarketsBody({ view }: { view: StyleMarketsView }) {
  const w = useT(NS)
  const locale = useLocale()
  if (view.marketCodes.length === 0) {
    return (
      <div className="fw-st-stack">
        <span className="fw-st-inline">
          <Tag tone="neutral">{w('markets.every')}</Tag>
        </span>
        <p className="fw-st-hint">{w('markets.everyMeans')}</p>
      </div>
    )
  }
  const byCode = new Map(view.markets.map((market) => [market.code, market]))
  return (
    <div className="fw-st-stack">
      <ul className="fw-smk-picked" aria-label={w('markets.pickedLabel', { count: view.marketCodes.length })}>
        {view.marketCodes.map((code) => {
          const market = byCode.get(code)
          return (
            <li key={code}>
              <Tag tone="info">{market ? w('markets.named', { name: marketName(market, locale), code }) : code}</Tag>
              {market && marketMarks(market, view.style.companyId).map((mark) => <Tag key={mark} tone="warning">{w(mark)}</Tag>)}
            </li>
          )
        })}
      </ul>
      <p className="fw-st-hint">{w('markets.listMeans')}</p>
    </div>
  )
}

/** The languages the gates ask in a market, in words ("DoC it · user information it · label it, en"). */
function LanguagesLine({ market }: { market: MarketChoice }) {
  const w = useT(NS)
  const list = (codes: readonly string[]) => (codes.length > 0 ? codes.join(', ') : w('markets.none'))
  return <>{w('markets.languages', { doc: list(market.docLanguages), info: list(market.userInfoLanguages), label: list(market.labelLanguages) })}</>
}

function MarketsPick({ model, view, actions }: { model: MarketsModel; view: StyleMarketsView; actions?: MarketsActions }) {
  const w = useT(NS)
  const locale = useLocale()
  const held = saveHeld(model)
  const codes = model.pick?.codes ?? []
  const save = () => {
    if (!held) actions?.onSave?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={w('markets.pickTitle', { code: model.styleCode })}
      size="md"
      footer={
        <>
          <Button variant="quiet" heldReason={codes.length === 0 ? w('markets.held.everyAlready') : null} onClick={() => actions?.onEvery?.()}>
            {w('markets.clear')}
          </Button>
          <span className="grow" />
          <Button onClick={() => actions?.onClose?.()}>{w('markets.cancel')}</Button>
          <Button variant="primary" heldReason={held ? w(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {w('markets.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={w(model.problem)} />}
        <p className="fw-st-hint">{codes.length === 0 ? w('markets.pickEvery') : w('markets.pickCount', { count: codes.length })}</p>
        <fieldset className="fw-smk-pick">
          <legend className="fw-sdp-sr">{w('markets.pickLegend')}</legend>
          {pickChoices(view).map((market) => {
            const checked = codes.includes(market.code)
            const marks = marketMarks(market, view.style.companyId)
            // A market no longer offered can only be taken off (the API keeps what is named, adds only what it offers).
            const locked = !market.offered && !checked
            return (
              <CheckboxCard
                key={market.code}
                variant="row"
                selected={checked}
                checked={checked}
                disabled={locked}
                title={
                  <span className="fw-st-inline fw-sdp-wrap">
                    <span>{w('markets.named', { name: marketName(market, locale), code: market.code })}</span>
                    {marks.map((mark) => (
                      <Tag key={mark} tone="warning">
                        {w(mark)}
                      </Tag>
                    ))}
                  </span>
                }
                description={
                  <>
                    <LanguagesLine market={market} />
                    {!market.offered && <> · {w('markets.notOffered')}</>}
                  </>
                }
                onChange={() => actions?.onToggle?.(market.code)}
              />
            )
          })}
        </fieldset>
        <p className="fw-st-hint">{w('markets.pickMeans')}</p>
      </div>
    </Modal>
  )
}
