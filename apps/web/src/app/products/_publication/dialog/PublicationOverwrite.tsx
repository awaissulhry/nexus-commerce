import type { StudioPublishOverwrite } from '@nexus/shared/studio-publication'
import { Banner } from '@/design-system/components'
import { Checkbox } from '@/design-system/primitives'
import styles from './publication.module.css'

const valueText = (value: unknown) => value == null ? 'No recorded value' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const readTime = (at: string) => <time dateTime={at}>{at.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC').replace(/Z$/, ' UTC')}</time>

/** Historical observations are evidence of overwrite exposure, not a change-only payload preview. */
export function PublicationOverwrite({ overwrite, confirmed, onConfirm, disabled }: {
  overwrite: StudioPublishOverwrite
  confirmed: boolean
  onConfirm(confirmed: boolean): void
  disabled: boolean
}) {
  if (!overwrite.requiresConfirmation) return null
  return <section className={styles.body} aria-label="Channel content overwrite warning">
    <Banner tone="warning" title="Publish can overwrite channel content">
      This publish sends the included products with all content Nexus prepares for this destination. It can overwrite channel values,
      including fields you did not change. The observations below are previous content reads, not a live check.
    </Banner>
    <div className={styles.observations} role="region" aria-label="Content observations by product" tabIndex={0}>
      {overwrite.products.map(product => <section key={product.productId} className={styles.observation} aria-label={`${product.sku} content observation`}>
        <strong>{product.sku}</strong>
        {product.status === 'new' ? <p>New listing — no previous channel content to compare.</p>
          : product.status === 'not_read' ? <p>Not read yet — channel content is unknown.</p>
          : product.status === 'not_compared' ? <p>Could not compare — channel differences remain unknown.</p>
          : <p>{product.differing ? `${product.differing} ${product.differing === 1 ? 'difference' : 'differences'} recorded.` : 'No differences recorded in the compared fields.'}</p>}
        {product.checkedAt && <p>Last content check: {readTime(product.checkedAt)}</p>}
        {product.reason && <p>{product.reason}</p>}
        {product.status !== 'new' && (product.notCompared == null ? <p>Content comparison coverage is unknown.</p>
          : product.notCompared > 0 ? <p>{product.notCompared} {product.notCompared === 1 ? 'field could' : 'fields could'} not be compared.</p> : null)}
        {product.fields.map(field => <div className={styles.observedField} key={field.field}>
          <strong>{field.field}</strong>
          <p>Difference observed: {readTime(field.checkedAt)}</p>
          <dl className={styles.observedValues}>
            <div><dt>Nexus at read</dt><dd>{valueText(field.nexusAtRead)}</dd></div>
            <div><dt>Channel at read</dt><dd>{valueText(field.channelAtRead)}</dd></div>
          </dl>
        </div>)}
        {product.omittedDifferences > 0 && <p>{product.omittedDifferences} additional {product.omittedDifferences === 1 ? 'difference has' : 'differences have'} no stored field detail. The recorded list is incomplete.</p>}
      </section>)}
    </div>
    <Checkbox tone="warning" disabled={disabled} checked={confirmed} onChange={event => onConfirm(event.target.checked)}
      label="I understand this can overwrite channel values, including fields I did not change." />
  </section>
}
