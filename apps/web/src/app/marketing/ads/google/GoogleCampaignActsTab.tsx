'use client'

/**
 * Google Ads step 1b, WB — "Google acts on its own" for ONE campaign, in the campaign window: the settings with which
 * Google may show this campaign's ads for searches, pages or text nobody chose (its row of R12), whether auto-apply is
 * on in the account, and the changes made to this campaign outside Nexus (every change, since Nexus makes none).
 *
 * A setting Nexus has not read says "Not read yet" — never "Off". Read only: no control here changes Google Ads.
 */
import { Banner, EmptyState, KeyValue, SummaryTable, type KeyValueItem } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { fetchGoogleActsOnItsOwn, type GoogleActsOnItsOwn } from '@/lib/google-ads/contract'
import { changesNote, formatDay, formatInt } from './googleAds'
import {
  ACTS_FLAGS, byGoogle, campaignOutsideChanges, flagsOnCount, flagWord, lastTryText, notReadText, notReadYet, NOUN, OUTSIDE_CHANGE_COLUMNS,
} from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'
import './googleModal.css'

export function GoogleCampaignActsTab({ account, externalCampaignId, nextReadAt }: {
  account: string | null
  /** Google's id of the campaign (R12 lists every campaign of the account). */
  externalCampaignId: string
  nextReadAt: string | null
}) {
  const read = useGoogleRead<GoogleActsOnItsOwn>(googleReadKey('acts-on-its-own', account), () => fetchGoogleActsOnItsOwn({ account }))
  const data = read.data

  if (read.error) {
    return (
      <Banner tone="danger" title="What Google does on its own could not be loaded" action={<Button onClick={read.reload}>Try again</Button>}>
        {read.error}
      </Banner>
    )
  }
  if (!data) return <Skeleton height={240} radius="var(--nds-radius-lg)" />

  const c = data.campaigns.find((x) => x.externalCampaignId === externalCampaignId) ?? null
  const settingsRead = !notReadYet(data.read.settings) && c != null && c.flagsReadAt != null
  const on = c ? flagsOnCount(c) : null
  const autoApplyOn = data.autoApply?.enabled.length ?? null
  const changes = campaignOutsideChanges(data.outsideChanges.items, externalCampaignId)
  const byGoogleCount = data.outsideChanges.items.filter((x) => x.externalCampaignId === externalCampaignId && byGoogle(x)).length

  const flags: KeyValueItem[] = c && settingsRead ? [
    ...ACTS_FLAGS.map((f) => {
      const w = flagWord(c[f.key])
      return {
        label: f.label,
        value: w.text === 'On' || w.text === 'Off' ? <Pill tone={w.tone} size="sm">{w.text}</Pill> : <span className="gads-dim">{w.text}</span>,
        hint: f.key === 'finalUrlExpansion' && c.finalUrlExpansionByDefault ? `${f.tip} On by default for this type of campaign.` : f.tip,
      }
    }),
    { label: 'Brand exclusions', value: c.brandExclusions == null ? <span className="gads-dim">Not read yet</span> : formatInt(c.brandExclusions), hint: 'Brand lists that keep this campaign’s ads off searches for those brands.' },
    ...(c.aiMax === 'on' ? [{ label: 'Ad groups without search term matching', value: c.adGroupsWithoutSearchTermMatching == null ? <span className="gads-dim">Not read yet</span> : formatInt(c.adGroupsWithoutSearchTermMatching), hint: 'Ad groups where AI Max does not look beyond the keywords.' }] : []),
    ...(c.movedToAiMaxAt ? [{ label: 'Moved to AI Max', value: formatDay(c.movedToAiMaxAt), hint: 'Google moved this campaign to AI Max by itself.' }] : []),
  ] : []

  return (
    <div className="gads-acts">
      <p className="gads-meta">Google can change a campaign without asking. This shows where it can for this campaign, and what was changed.</p>

      <section className="gads-section" aria-labelledby="gads-acts-flags-h">
        <h3 id="gads-acts-flags-h">Settings that widen where the ads show{on != null && settingsRead ? ` · on in ${on}` : ''}</h3>
        {settingsRead ? (
          <>
            <p className="gads-note">When one of these is on, Google may show the ads for searches, pages or text you did not choose.</p>
            <KeyValue items={flags} columns={2} />
          </>
        ) : (
          <EmptyState title="Not read yet" description={notReadText(NOUN.setting, 'campaign', data.read.settings, nextReadAt)} />
        )}
      </section>

      <section className="gads-section" aria-labelledby="gads-acts-auto-h">
        <h3 id="gads-acts-auto-h">Auto-apply</h3>
        <p className="gads-note">
          {autoApplyOn == null
            ? `Nexus has not read auto-apply from Google yet.${lastTryText(data.read.autoApply) ? ` ${lastTryText(data.read.autoApply)}` : ''}`
            : autoApplyOn === 0
              ? 'Auto-apply is off for every kind of Google’s recommendations in this account.'
              : `Auto-apply is on for ${autoApplyOn === 1 ? 'one kind' : `${autoApplyOn} kinds`} of Google’s recommendations in this account (${data.autoApply!.enabled.map((a) => a.typeText).join(', ')}). Google makes these changes without asking, in this campaign too. You switch them off in Google Ads, under Recommendations › Auto-apply.`}
        </p>
      </section>

      <section className="gads-section" aria-labelledby="gads-acts-changes-h">
        <h3 id="gads-acts-changes-h">Changes made outside Nexus</h3>
        <p className="gads-note">Nexus makes no changes in Google Ads yet, so every change here was made outside Nexus: by Google itself or by people in Google Ads.</p>
        <p className="gads-meta">{changesNote(data.outsideChanges, changes.length)}</p>
        {changes.length > 0 && (
          <>
            <p className="gads-meta">{byGoogleCount === 0 ? 'Google made none of them by itself.' : `Google made ${formatInt(byGoogleCount)} of them by itself.`} The list holds the account’s newest 200 changes; the Changes tab has every change to this campaign.</p>
            <div className="gads-table" tabIndex={0} role="region" aria-label="Changes made outside Nexus">
              <SummaryTable label="Changes to this campaign made outside Nexus" columns={OUTSIDE_CHANGE_COLUMNS} rows={changes} />
            </div>
          </>
        )}
      </section>
    </div>
  )
}
