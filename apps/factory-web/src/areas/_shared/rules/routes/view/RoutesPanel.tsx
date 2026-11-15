'use client'

import { MapPin, Plus, Trash2, UserRound, Users } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ROUTE_SCOPES, type RuleRoutes } from '../api'
import { placeOptions, routeHeld, scopesOffered, type RouteDraft } from '../model'
import '../routes.css'

/** A rule's routes (design home.alerts › Rules "goes to (role and place)"). */
export interface RoutesModel {
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: RuleRoutes }
  readonly draft: RouteDraft | null
  /** The route being removed, or 'add' while a route is added. */
  readonly busy: string | null
  readonly offline: boolean
  readonly notice: { readonly key: string; readonly tone: 'success' | 'danger' } | null
}

export interface RoutesActions {
  onDraft?: (change: Partial<RouteDraft>) => void
  onAdd?: () => void
  onRemove?: (routeId: string) => void
  onRetry?: () => void
}

/**
 * SCR-645 — a rule's routes (B-W2b-435; ANA-041 "alert routing by place and role"), inside the rule dialog (Home › Alerts and
 * Admin › Automation): who the rule tells at a company, a site, a line or a customer of its place — the holders of an office role
 * there (through the same scopes as their permissions) or one office person. An alert a route covers goes to the routes' people
 * only; elsewhere to the rule's own role (said). Add (held with why: the place, whom, the limit, offline) and Remove; a person who
 * may not change the rule reads them. A route is added and removed, never changed. One view model, nothing fetched.
 */
export function RoutesPanel({ model, actions }: { model: RoutesModel; actions?: RoutesActions }) {
  return (
    <WithMessages namespaces={['home-digest']}>
      <Panel model={model} actions={actions} />
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: RoutesModel; actions?: RoutesActions }) {
  const t = useT('home-digest')
  const read = model.read
  return (
    <section className="fw-route" aria-labelledby="fw-route-h">
      <h3 id="fw-route-h" className="fw-route-h">
        <MapPin size={14} aria-hidden /> {t('routes.title')}
      </h3>
      <p className="fw-route-muted">{t('routes.intro')}</p>
      {read.status === 'loading' ? (
        <Skeleton height={48} />
      ) : read.status === 'error' ? (
        <Banner tone="danger" title={t(read.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('digest.retry')}</Button>} />
      ) : (
        <>
          {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key)} />}
          {read.data.routes.length === 0 ? (
            <p className="fw-route-muted">{t('routes.none')}</p>
          ) : (
            <ul className="fw-route-list" aria-label={t('routes.title')}>
              {read.data.routes.map((route) => (
                <li key={route.id} className="fw-route-item">
                  <Tag tone="info">{t(`routes.scope.${route.scope}`)}</Tag>
                  <span>{route.place.code ? `${route.place.code} · ${route.place.label}` : route.place.label}</span>
                  <span className="fw-route-muted">→</span>
                  <span className="fw-route-who">
                    {route.who.kind === 'ROLE' ? <Users size={13} aria-hidden /> : <UserRound size={13} aria-hidden />} {route.who.kind === 'ROLE' ? t('routes.whoRole', { role: route.who.name }) : route.who.name}
                  </span>
                  {read.data.canChange && (
                    <Button size="sm" variant="quiet" tone="danger" onClick={() => actions?.onRemove?.(route.id)} heldReason={model.offline ? t('routes.held.offline') : model.busy ? t('routes.held.busy') : null} aria-label={t('routes.remove', { place: route.place.label })}>
                      {model.busy === route.id ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden />}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="fw-route-muted">{read.data.routes.length > 0 ? t('routes.elsewhere') : t('routes.ruleRole')}</p>
          {read.data.canChange && read.data.choices ? <AddForm model={model} data={read.data} actions={actions} /> : !read.data.canChange ? <p className="fw-route-muted">{t('routes.readOnly')}</p> : null}
        </>
      )}
    </section>
  )
}

function AddForm({ model, data, actions }: { model: RoutesModel; data: RuleRoutes; actions?: RoutesActions }) {
  const t = useT('home-digest')
  const choices = data.choices!
  const draft = model.draft
  const offered = scopesOffered(choices)
  const held = routeHeld(draft, { count: data.routes.length, max: data.max, offline: model.offline, busy: model.busy !== null })
  if (!draft || offered.length === 0) return <p className="fw-route-muted">{t('routes.noPlaces')}</p>
  const places = placeOptions(choices, draft.scope)
  return (
    <form
      className="fw-route-form"
      aria-label={t('routes.add')}
      onSubmit={(event) => {
        event.preventDefault()
        if (!held) actions?.onAdd?.()
      }}
    >
      <Field label={t('routes.field.scope')}>
        <Select
          value={draft.scope}
          onChange={(event) => {
            const scope = ROUTE_SCOPES.find((entry) => entry === event.target.value)
            if (scope) actions?.onDraft?.({ scope, scopeId: placeOptions(choices, scope)[0]?.value ?? '' })
          }}
        >
          {offered.map((scope) => (
            <option key={scope} value={scope}>
              {t(`routes.scope.${scope}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('routes.field.place')} hint={draft.scope === 'CUSTOMER' && !choices.customersComplete ? t('routes.customersCut') : undefined}>
        <Select value={draft.scopeId} onChange={(event) => actions?.onDraft?.({ scopeId: event.target.value })}>
          {places.map((place) => (
            <option key={place.value} value={place.value}>
              {place.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('routes.field.who')}>
        <SegmentedControl
          ariaLabel={t('routes.field.who')}
          size="sm"
          value={draft.who}
          onChange={(value) => actions?.onDraft?.({ who: value === 'PERSON' ? 'PERSON' : 'ROLE' })}
          options={[
            { value: 'ROLE', label: t('routes.who.ROLE') },
            { value: 'PERSON', label: t('routes.who.PERSON') },
          ]}
        />
      </Field>
      {draft.who === 'ROLE' ? (
        <Field label={t('routes.field.role')}>
          <Select value={draft.roleId} onChange={(event) => actions?.onDraft?.({ roleId: event.target.value })}>
            {choices.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label={t('routes.field.person')}>
          <Select value={draft.userId} onChange={(event) => actions?.onDraft?.({ userId: event.target.value })}>
            {choices.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="fw-route-add">
        <Button size="sm" variant="secondary" type="submit" heldReason={held ? t(held, { max: data.max }) : null}>
          {model.busy === 'add' ? <Spinner size={12} /> : <Plus size={13} aria-hidden />} {t('routes.add')}
        </Button>
      </div>
    </form>
  )
}
