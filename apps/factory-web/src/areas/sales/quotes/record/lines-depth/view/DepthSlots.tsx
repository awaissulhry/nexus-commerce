'use client'

import type { ReactNode } from 'react'
import { ExternalLink, Wand2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { Translate } from '../../../../../../lib/i18n/messages'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { PasteLines, type PasteLinesActions, type PasteLinesModel } from '../../../paste/view/PasteLines'
import { TargetPrice, type TargetPriceActions, type TargetPriceModel } from '../../goalseek/view/TargetPrice'
import { DepositPayLink, type DepositPayLinkActions, type DepositPayLinkModel } from '../../terms-depth/view/DepositPayLink'
import { DeliveryPart, ValidityPart, type TermsDepthActions, type TermsDepthModel } from '../../terms-depth/view/TermsDepth'
import { CompareVersions, type CompareVersionsActions, type CompareVersionsModel } from '../../versions-depth/view/CompareVersions'
import { VersionsList, type VersionsListActions, type VersionsListModel } from '../../versions-depth/view/VersionsList'
import { DEPTH_NS, type Tone, type Words } from '../model'
import type { QuoteDepthSlots } from '../slots'
import { useDepthWords } from '../words'
import { BulkReview, type BulkReviewActions, type BulkReviewModel } from './BulkReview'
import { LineDrawer, type LineDrawerActions, type LineDrawerModel } from './LineDrawer'
import { LinesTable, type LinesTableActions, type LinesTableModel } from './LinesTable'
import { ComposerExtra, LinesTop, type ComposerExtraModel, type LinesTopModel, type LinesView } from './LinesTop'
import '../depth.css'

/** Everything the quote record's W2b parts draw (B-W2b-316): the container fills it live, the design index from made-up data. */
export interface QuoteDepthModel {
  notice: { words: Words; tone: Tone } | null
  /** null: not on the Lines tab. */
  linesTop: LinesTopModel | null
  /** The Table view (null: the style blocks). */
  table: LinesTableModel | null
  composer: ComposerExtraModel
  /** The blocks' ⋯ may offer Fill by curve (a draft the person edits, size-grid lines). */
  canFill: boolean
  goal: TargetPriceModel | null
  terms: TermsDepthModel | null
  versions: VersionsListModel | null
  deposit: DepositPayLinkModel | null
  drawer: LineDrawerModel | null
  bulk: BulkReviewModel | null
  paste: PasteLinesModel | null
  compare: CompareVersionsModel | null
}

export interface QuoteDepthActions {
  onDismissNotice?: () => void
  onView?: (view: LinesView) => void
  onRetryWarnings?: () => void
  table?: LinesTableActions
  onPaste?: () => void
  onOpenLine?: (lineId: string) => void
  onFill?: (styleId: string) => void
  goal?: TargetPriceActions
  terms?: TermsDepthActions
  versions?: VersionsListActions
  deposit?: DepositPayLinkActions
  drawer?: LineDrawerActions
  bulk?: BulkReviewActions
  paste?: PasteLinesActions
  compare?: CompareVersionsActions
}

const Depth = ({ children }: { children: ReactNode }) => <WithMessages namespaces={['sales', DEPTH_NS]}>{children}</WithMessages>

function Notice({ notice, onDismiss }: { notice: NonNullable<QuoteDepthModel['notice']>; onDismiss?: () => void }) {
  const { t, say } = useDepthWords()
  return (
    <Banner
      tone={notice.tone}
      title={say(notice.words)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/**
 * The record's W2b slots from one model (slots.ts says where each sits). `t` is the depth catalogue's translator (the
 * block menu's words are strings: W1's Menu takes them as they are).
 */
export function depthSlots(model: QuoteDepthModel, actions: QuoteDepthActions | undefined, t: Translate): QuoteDepthSlots {
  return {
    notice: model.notice ? (
      <Depth>
        <Notice notice={model.notice} onDismiss={actions?.onDismissNotice} />
      </Depth>
    ) : undefined,
    linesTop: model.linesTop ? (
      <Depth>
        <LinesTop model={model.linesTop} onView={actions?.onView} onRetryWarnings={actions?.onRetryWarnings} />
      </Depth>
    ) : undefined,
    linesTable: model.table ? (
      <Depth>
        <LinesTable model={model.table} actions={actions?.table} />
      </Depth>
    ) : null,
    composerExtra: (
      <Depth>
        <ComposerExtra model={model.composer} onPaste={actions?.onPaste} />
      </Depth>
    ),
    blockItems: (block) => [
      ...[...block.lines]
        .sort((a, b) => a.seq - b.seq)
        .map((line) => ({ id: `open-${line.id}`, label: t('block.openLine', { colour: `${line.colourway.code} · ${line.colourway.name}` }), icon: <ExternalLink size={14} aria-hidden />, onSelect: () => actions?.onOpenLine?.(line.id) })),
      ...(model.canFill && block.lines.some((line) => line.kind === 'SIZE_GRID') ? [{ id: 'fill', label: t('block.fill'), icon: <Wand2 size={14} aria-hidden />, onSelect: () => actions?.onFill?.(block.styleId) }] : []),
    ],
    price: model.goal ? (
      <Depth>
        <TargetPrice model={model.goal} actions={actions?.goal} />
      </Depth>
    ) : undefined,
    termsValidity: model.terms ? (
      <Depth>
        <ValidityPart model={model.terms} actions={actions?.terms} />
      </Depth>
    ) : undefined,
    termsDelivery: model.terms ? (
      <Depth>
        <DeliveryPart model={model.terms} actions={actions?.terms} />
      </Depth>
    ) : undefined,
    versionsList: model.versions ? (
      <Depth>
        <VersionsList model={model.versions} actions={actions?.versions} />
      </Depth>
    ) : undefined,
    depositActions: model.deposit ? (
      <Depth>
        <DepositPayLink model={model.deposit} actions={actions?.deposit} />
      </Depth>
    ) : undefined,
    overlay:
      model.drawer || model.bulk || model.paste || model.compare ? (
        <Depth>
          {model.drawer && <LineDrawer model={model.drawer} actions={actions?.drawer} />}
          {model.bulk && <BulkReview model={model.bulk} actions={actions?.bulk} />}
          {model.paste && <PasteLines model={model.paste} actions={actions?.paste} />}
          {model.compare && <CompareVersions model={model.compare} actions={actions?.compare} />}
        </Depth>
      ) : undefined,
  }
}
