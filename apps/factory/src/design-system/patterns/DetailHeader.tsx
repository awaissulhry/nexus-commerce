import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

export interface DetailHeaderProps {
  backLabel?: ReactNode
  onBack?: () => void
  /**
   * Render the back control as the caller's own element — typically `<Link href>` — keeping the
   * DS's chrome and its chevron. Same idiom and same mechanism as `Button asChild`: pass the
   * element as `backLabel` and it is cloned with the class and the chevron injected before its
   * own children.
   *
   * It exists because a real anchor is the only back control that honours ⌘-click, middle-click
   * and "Open in new tab" — a `<button onClick={router.back}>` silently swallows all three.
   */
  backAsChild?: boolean
  /** leading badge slot (e.g. a targeting chip) */
  badge?: ReactNode
  title: ReactNode
  /** An independently controlled related-view menu, placed beside the heading. */
  titleMenu?: ReactNode
  /**
   * Identity that travels WITH the title — SKU, external id, a status pill. Not a subtitle: it
   * sits on the title's own line so a `dense` header stays one row.
   */
  meta?: ReactNode
  /**
   * A state region between the title and the actions — an autosave indicator, a sync clock. Kept
   * apart from `actions` because it is not clickable and should not read as a control.
   */
  status?: ReactNode
  actions?: ReactNode
  /**
   * Page chrome rather than a section head: ONE row, the back link inline before the title, a
   * smaller title, a bottom hairline and no bottom margin.
   *
   * The default two-row form introduces a section inside a padded page. A page whose whole body is
   * a grid has no such padding to sit in, and its header is a band — that is this.
   */
  dense?: boolean
  className?: string
}

/**
 * Drill-in detail header (H10 `.h10-cd-hdr`): back link + badge + title + actions.
 *
 * Two forms from one component. Default = the section head it always was, DOM-identical when the
 * props below are omitted (verified: its only consumer is the DS catalog). `dense` = the one-row page band the Product Edit Studio's frame needs
 * (PES.1), where the back link, the identity, the live state and the actions share a single line.
 */
export function DetailHeader({
  backLabel = 'Back',
  onBack,
  backAsChild,
  badge,
  title,
  titleMenu,
  meta,
  status,
  actions,
  dense,
  className,
}: DetailHeaderProps) {
  const hasBack = backAsChild ? isValidElement(backLabel) : !!onBack

  const back = !hasBack ? null : backAsChild ? (
    cloneElement(
      backLabel as ReactElement<{ className?: string; children?: ReactNode }>,
      {
        className: ['back', (backLabel as ReactElement<{ className?: string }>).props.className]
          .filter(Boolean)
          .join(' '),
      },
      <ChevronLeft size={14} key="chev" />,
      (backLabel as ReactElement<{ children?: ReactNode }>).props.children,
    )
  ) : (
    <button type="button" className="back" onClick={onBack}>
      <ChevronLeft size={14} />
      {backLabel}
    </button>
  )

  const cls = ['nds-detailhdr', dense ? 'dense' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  // Dense is one row: the back link joins the title group instead of sitting above it.
  if (dense) {
    return (
      <div className={cls}>
        <div className="nds-detailhdr-row">
          <div className="nds-detailhdr-title">
            {back}
            {badge}
            <h1 title={typeof title === 'string' ? title : undefined}>{title}</h1>
            {titleMenu}
            {meta != null && <div className="nds-detailhdr-meta">{meta}</div>}
          </div>
          {(status != null || actions != null) && (
            <div className="nds-detailhdr-right">
              {status != null && <div className="nds-detailhdr-status">{status}</div>}
              {actions != null && <div className="nds-pagehdr-actions">{actions}</div>}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cls}>
      {back}
      <div className="nds-detailhdr-row">
        <div className="nds-detailhdr-title">
          {badge}
          <h1 title={typeof title === 'string' ? title : undefined}>{title}</h1>
          {titleMenu}
          {meta != null && <div className="nds-detailhdr-meta">{meta}</div>}
        </div>
        {/* No `status` means no wrapper: the existing form renders `.nds-pagehdr-actions` as the
            row's own second child, and quietly adding a flex box around it would change the
            layout of the one surface already using this component. */}
        {status != null ? (
          <div className="nds-detailhdr-right">
            <div className="nds-detailhdr-status">{status}</div>
            {actions != null && <div className="nds-pagehdr-actions">{actions}</div>}
          </div>
        ) : (
          actions != null && <div className="nds-pagehdr-actions">{actions}</div>
        )}
      </div>
    </div>
  )
}
