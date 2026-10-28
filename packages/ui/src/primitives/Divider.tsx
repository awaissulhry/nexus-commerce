export interface DividerProps {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

/** Hairline rule (subtle border). */
export function Divider({ orientation = 'horizontal', className }: DividerProps) {
  const cls = ['nds-divider', orientation === 'vertical' ? 'vertical' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  return <hr className={cls} aria-orientation={orientation} />
}
