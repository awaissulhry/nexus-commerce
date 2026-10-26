'use client'

/**
 * Reviews Overview — "What buyers love" and "What needs fixing": the themes mentioned most in the period, from reviews
 * (their sentiment themes) and Amazon's own review topics (Customer Feedback API; not on Amazon.nl). Each names its
 * source and quotes a buyer; a quote in another language carries its translation once the Inbox translates (PR B).
 * A review theme opens the Inbox on that theme.
 */
import { Card, EmptyState, ProgressBar } from '@/design-system/components'
import { Button, Skeleton, Tag } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { insightsHref } from '../_lib/reviewsLinks'
import { overviewPeriodWords, themeCountWords, themeHref, type OverviewTheme } from './overviewModel'
import type { OverviewPeriod } from './overviewQuery'
import { SectionError } from './SectionError'
import s from './overview.module.css'

function ThemeList({ themes, tone, label, period }: { themes: OverviewTheme[]; tone: 'complete' | 'missing'; label: string; period: OverviewPeriod }) {
  return (
    <ul className={s.themeList} aria-label={label}>
      {themes.map((t) => (
        <li key={t.key} className={s.themeItem}>
          <div className={s.themeHead}>
            <Link href={themeHref(t, period)} className={s.themeName}>{t.label}</Link>
            {/* The bar repeats the share in the words beside it: hidden from a screen reader. */}
            <span className={s.themeBar} aria-hidden>
              <ProgressBar value={t.share ?? 0} tone={tone} height={8} />
            </span>
            <span className={s.themeCount}>{themeCountWords(t)}</span>
          </div>
          {t.quote && (
            <p className={s.themeQuote}>
              {t.quoteFrom && <Tag tone="neutral" className={s.themeSource}>{t.quoteFrom}</Tag>}
              {t.quote}
            </p>
          )}
          {t.english && <p className={s.themeEnglish}>Translated: {t.english}</p>}
        </li>
      ))}
    </ul>
  )
}

export interface ThemeCardsProps {
  themes: { love: OverviewTheme[]; fix: OverviewTheme[] } | null
  error: string | null
  loading: boolean
  period: OverviewPeriod
  onRetry: () => void
}

export function ThemeCards({ themes, error, loading, period, onRetry }: ThemeCardsProps) {
  const { label } = overviewPeriodWords(period)
  const body = (kind: 'love' | 'fix') => {
    if (error) return <div className={s.pad}><SectionError error={error} onRetry={onRetry} busy={loading} /></div>
    if (!themes) return <div className={s.pad} aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} height={44} className={s.skeletonRow} />)}</div>
    const list = themes[kind]
    if (list.length === 0) {
      return kind === 'love'
        ? <EmptyState title="No themes yet" description={`Themes show once reviews in the ${label} have been read for what they mention.`} />
        : <EmptyState title="Nothing to fix in this period" description={`No negative review in the ${label} mentions a theme.`} />
    }
    return <ThemeList themes={list} tone={kind === 'love' ? 'complete' : 'missing'} label={kind === 'love' ? 'Themes in positive reviews' : 'Themes in negative reviews'} period={period} />
  }

  return (
    <div className={s.row}>
      <Card
        className={s.theme}
        header="What buyers love"
        headingLevel={2}
        description={`How often buyers mention it · ${label}`}
        headerAction={<Button asChild variant="link" size="sm"><Link href={insightsHref('themes')}>All themes</Link></Button>}
        padded={false}
      >
        {body('love')}
      </Card>
      <Card
        className={s.theme}
        header="What needs fixing"
        headingLevel={2}
        description={`How often buyers complain about it · ${label}`}
        headerAction={<Button asChild variant="link" size="sm"><Link href={insightsHref('fixes')}>Suggested fixes</Link></Button>}
        padded={false}
      >
        {body('fix')}
      </Card>
    </div>
  )
}
