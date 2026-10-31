'use client'

import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import '../../scope.css'

/**
 * B-W2b-05 (SCR-007 card "Where I work", design shell.scope sec:defaults): what opens after sign-in — Today (the
 * default) or a saved view the person picks (a list page, then one of its views). Sign-in opens the company and site
 * used last (said in words). One view model; the container (StartPageCard) reads the views and keeps the choice.
 */

export interface StartPageViewModel {
  choice: 'today' | 'view'
  /** The person's list pages (labels already in words). */
  pages: ReadonlyArray<{ href: string; label: string; area: string }>
  page: string | null
  views: { status: 'idle' | 'loading' | 'error'; items?: undefined } | { status: 'ready'; items: ReadonlyArray<{ id: string; name: string }> }
  viewId: string | null
  /** Something differs from what is kept. */
  changed: boolean
  /** Just kept ("Saved: …"). */
  saved?: boolean
}

export interface StartPageActions {
  onChoice?: (choice: 'today' | 'view') => void
  onPage?: (page: string) => void
  onView?: (viewId: string) => void
  onSave?: () => void
  onDiscard?: () => void
}

export function StartPageView({ model, actions }: { model: StartPageViewModel; actions?: StartPageActions }) {
  const t = useT('shell')
  const needsView = model.choice === 'view' && !model.viewId
  const held = !model.changed ? t('scope.start.heldNoChange') : needsView ? t('scope.start.heldPickView') : null
  return (
    <Card header={t('scope.start.title')} description={t('scope.start.description')} headingLevel={2}>
      <form
        className="fw-start-page"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onSave?.()
        }}
      >
        <fieldset className="fw-start-page">
          <legend className="fw-visually-hidden-legend">{t('scope.start.legend')}</legend>
          <RadioCard
            name="fw-start"
            variant="row"
            title={t('scope.start.today')}
            description={t('scope.start.todayHint')}
            checked={model.choice === 'today'}
            selected={model.choice === 'today'}
            onChange={() => actions?.onChoice?.('today')}
          />
          <RadioCard
            name="fw-start"
            variant="row"
            title={t('scope.start.view')}
            description={t('scope.start.viewHint')}
            checked={model.choice === 'view'}
            selected={model.choice === 'view'}
            onChange={() => actions?.onChoice?.('view')}
          />
        </fieldset>
        {model.choice === 'view' && (
          <div className="fw-start-page-pickers">
            <Field label={t('scope.start.page')}>
              <Select value={model.page ?? ''} onChange={(event) => actions?.onPage?.(event.target.value)}>
                <option value="" disabled>
                  {t('scope.start.pickPage')}
                </option>
                {model.pages.map((page) => (
                  <option key={page.href} value={page.href}>
                    {page.area} › {page.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('scope.start.savedView')} hint={model.views.status === 'ready' && model.views.items.length === 0 ? t('scope.start.noViews') : undefined}>
              {model.views.status === 'loading' ? (
                <p className="fw-company-finder-empty" role="status">
                  <Spinner size={14} /> {t('scope.start.loadingViews')}
                </p>
              ) : (
                <Select value={model.viewId ?? ''} disabled={model.views.status !== 'ready' || model.views.items.length === 0} onChange={(event) => actions?.onView?.(event.target.value)}>
                  <option value="" disabled>
                    {model.page ? t('scope.start.pickView') : t('scope.start.pickPageFirst')}
                  </option>
                  {model.views.status === 'ready' &&
                    model.views.items.map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        {model.views.status === 'error' && <Banner tone="danger" title={t('scope.start.viewsFailed')} />}
        <p className="fw-company-finder-empty">{t('scope.start.signIn')}</p>
        <div className="fw-start-page-actions">
          <Button type="submit" variant="primary" size="sm" heldReason={held}>
            {t('scope.start.save')}
          </Button>
          {model.changed && (
            <Button type="button" variant="quiet" size="sm" onClick={actions?.onDiscard}>
              {t('scope.start.discard')}
            </Button>
          )}
          {model.saved && !model.changed && (
            <span className="fw-company-finder-empty" role="status">
              {t('scope.start.saved')}
            </span>
          )}
        </div>
      </form>
    </Card>
  )
}
