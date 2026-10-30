'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { Banner, Listbox } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { useWords } from '../../kit/parts'
import { adminHref, type Loaded } from '../../shared/model'
import { BulkConfirm } from '../../shared/view/BulkConfirm'
import { ListState } from '../../shared/view/parts'
import { endonymOf, floorHasWords, floorPlanOf, localesAfter, type FloorDialog, type FloorProblem, type FloorSite } from '../model'

export interface FloorLanguagesProps {
  prefix: string
  floor: Loaded<FloorSite>
  dialog?: FloorDialog | null
  problem?: FloorProblem | null
  busy?: boolean
  /** Saves the site's languages after the change (PUT with the site's version); the page refreshes the section. */
  onChange?: (site: FloorSite, dialog: FloorDialog, locales: string[], reason: string) => Promise<void> | void
  onRetry?: () => void
}

/**
 * Floor languages (B-W2a-41; PLT-128; design 02 admin.languages "Floor languages"): per site, the languages its tablets
 * offer workers, each named in its own words (never a flag) with the site's active workers who read it and whether the
 * worker notice in force has it; add one (only a language the notice has: the others are listed, held with the reason)
 * and remove one (never the last, never one workers read) after a confirm. The floor screens speak Italiano and English;
 * another language is said plainly to show them in Italiano or English until its words exist. Fetches nothing.
 */
export function FloorLanguages({ prefix, floor, dialog: shown, problem, busy, onChange, onRetry }: FloorLanguagesProps) {
  const t = useT('admin-languages')
  const [dialog, setDialog] = useState<FloorDialog | null>(shown ?? null)
  useEffect(() => setDialog(shown ?? null), [shown])
  if (floor.problem || floor.items === null) return <ListState problem={floor.problem} loading={floor.items === null} onRetry={onRetry} rows={3} />
  const sites = floor.items.filter((site) => site.status === 'ACTIVE')
  const open = dialog ? sites.find((site) => site.id === dialog.siteId) ?? null : null
  return (
    <>
      {sites.length === 0 ? (
        <p className="fw-adm-hint">
          {t('langs.floor.noSite')}{' '}
          <Link className="fw-adm-langs-link" href={adminHref(prefix, '/companies')}>
            {t('langs.floor.noSiteLink')}
          </Link>
        </p>
      ) : (
        <div className="fw-adm-langs-sites">
          {sites.map((site) => (
            <FloorSiteBlock key={site.id} prefix={prefix} site={site} problem={problem?.siteId === site.id ? problem : null} onAsk={setDialog} />
          ))}
        </div>
      )}
      <p className="fw-adm-hint">{t('langs.floor.screensNote')}</p>
      {open && dialog && (
        <BulkConfirm
          open
          title={t(dialog.action === 'add' ? 'langs.floor.confirm.addTitle' : 'langs.floor.confirm.removeTitle', { language: endonymOf(dialog.code), site: `${open.companyCode} › ${open.name}` })}
          lines={[
            t(dialog.action === 'add' ? 'langs.floor.confirm.add' : 'langs.floor.confirm.remove', { language: endonymOf(dialog.code) }),
            ...(dialog.action === 'add' && !floorHasWords(dialog.code) ? [t('langs.floor.confirm.noWords', { language: endonymOf(dialog.code) })] : []),
            t('langs.floor.confirm.after', { languages: localesAfter(open, dialog).map(endonymOf).join(', ') }),
          ]}
          confirmLabel={t(dialog.action === 'add' ? 'langs.floor.add' : 'langs.floor.remove')}
          tone={dialog.action === 'add' ? 'primary' : 'danger'}
          reason
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => {
            const done = onChange?.(open, dialog, localesAfter(open, dialog), reason)
            void Promise.resolve(done).finally(() => setDialog(null))
          }}
        />
      )}
    </>
  )
}

function FloorSiteBlock({ prefix, site, problem, onAsk }: { prefix: string; site: FloorSite; problem: FloorProblem | null; onAsk: (dialog: FloorDialog) => void }) {
  const t = useT('admin-languages')
  const ta = useT('admin')
  const words = useWords('admin-languages')
  const plan = floorPlanOf(site)
  const heading = `langs-floor-${site.id}`
  const languageName = (code: string) => {
    const name = ta(`common.language.${code}`)
    return name === `common.language.${code}` ? code : name
  }
  const held = (key: string | null, params?: Readonly<Record<string, string | number>>) => (key === null ? null : t(key, params))
  return (
    <section className="fw-adm-langs-site-block" aria-labelledby={heading}>
      <div className="fw-adm-langs-site-head">
        <h3 id={heading} className="fw-adm-langs-h3">
          <Link className="fw-adm-name" href={adminHref(prefix, `/companies/${site.companyId}/sites/${site.id}`)}>
            {site.companyCode} › {site.name}
          </Link>
        </h3>
        {site.notice ? (
          <p className="fw-adm-hint">
            {t('langs.floor.notice', { label: site.notice.label, languages: site.notice.locales.map(endonymOf).join(', ') })}{' '}
            <Link className="fw-adm-langs-link" href={adminHref(prefix, '/privacy')}>
              {t('langs.floor.noticeLink')}
            </Link>
          </p>
        ) : (
          <p className="fw-adm-hint">
            <Pill tone="warning">{t('langs.floor.noNotice')}</Pill> {t('langs.floor.noNoticeWhy')}{' '}
            <Link className="fw-adm-langs-link" href={adminHref(prefix, '/privacy')}>
              {t('langs.floor.noticeLink')}
            </Link>
          </p>
        )}
      </div>
      {problem && <Banner tone="warning" title={words(problem.key, problem.params)} />}
      <ul className="fw-adm-list" aria-label={t('langs.floor.offered', { site: site.name })}>
        {plan.rows.map((row) => (
          <li key={row.code} className="fw-adm-langs-row">
            <span className="fw-adm-name" lang={row.code}>
              {row.endonym}
            </span>
            <span className="fw-adm-hint">{languageName(row.code)}</span>
            {row.inNotice !== null && <Pill tone={row.inNotice ? 'success' : 'warning'}>{t(row.inNotice ? 'langs.floor.inNotice' : 'langs.floor.notInNotice')}</Pill>}
            <Pill tone={row.screens ? 'success' : 'neutral'}>{t(row.screens ? 'langs.floor.screens' : 'langs.floor.notYet')}</Pill>
            {row.workers !== null && <span className="fw-adm-hint">{t('langs.floor.workers', { count: row.workers })}</span>}
            <span className="fw-adm-langs-row-end">
              <Button
                size="sm"
                variant="quiet"
                aria-label={t('langs.floor.removeFrom', { language: row.endonym, site: site.name })}
                heldReason={held(row.removeHeld?.key ?? null, row.removeHeld?.params)}
                onClick={() => onAsk({ siteId: site.id, action: 'remove', code: row.code })}
              >
                <Trash2 size={14} aria-hidden /> {t('langs.floor.remove')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="fw-adm-langs-add">
        {plan.addHeld ? (
          <Button size="sm" heldReason={held(plan.addHeld)}>
            {t('langs.floor.addOne')}
          </Button>
        ) : (
          <Listbox
            size="sm"
            ariaLabel={t('langs.floor.addTo', { site: site.name })}
            placeholder={t('langs.floor.addOne')}
            value=""
            width={240}
            options={plan.choices.map((choice) => ({
              value: choice.code,
              label: choice.endonym,
              note: choice.held ? t(choice.held) : floorHasWords(choice.code) ? undefined : t('langs.floor.notYet'),
              ...(choice.held ? { heldReason: t(choice.held) } : {}),
            }))}
            onChange={(code) => {
              const choice = plan.choices.find((item) => item.code === code)
              if (choice && !choice.held) onAsk({ siteId: site.id, action: 'add', code })
            }}
          />
        )}
        {plan.choices.some((choice) => choice.held) && site.notice && (
          <span className="fw-adm-hint">
            {t('langs.floor.notInNoticeList', {
              languages: plan.choices
                .filter((choice) => choice.held)
                .map((choice) => choice.endonym)
                .join(', '),
            })}
          </span>
        )}
      </div>
      {site.workers !== null && Object.keys(site.workers).some((code) => !site.locales.includes(code) && (site.workers?.[code] ?? 0) > 0) && (
        <p className="fw-adm-hint">
          {t('langs.floor.workersElse', {
            languages: Object.keys(site.workers)
              .filter((code) => !site.locales.includes(code) && (site.workers?.[code] ?? 0) > 0)
              .map(endonymOf)
              .join(', '),
          })}{' '}
          <Link className="fw-adm-langs-link" href={adminHref(prefix, '/users?audience=floor')}>
            {t('langs.floor.workersLink')}
          </Link>
        </p>
      )}
    </section>
  )
}
