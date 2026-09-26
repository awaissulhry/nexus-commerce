'use client'

/**
 * CHMAP — the decision for ONE channel column of a mapping version.
 *
 * On a DRAFT the Owner chooses: map to a field of the channel schema, map as an eBay item specific,
 * ignore (with a reason), managed elsewhere (with a reason), or leave unmapped. The server re-checks
 * every rule and its refusal is shown word for word; the screen repaints only from the version the
 * server returns.
 *
 * An ACTIVE or RETIRED version, and the SKU / product-type / action columns, are read-only here — the
 * drawer says why and, for a frozen version, offers the one way to change it (a new version).
 */
import { useEffect, useId, useState } from 'react'
import type { MappingFieldRow, MappingSetDetail } from '@nexus/shared/channel-mapping'
import { Button, Input, RadioCard, Textarea } from '@/design-system/primitives'
import { Banner, Drawer, Field, KeyValue, Listbox } from '@/design-system/components'
import { num } from '@/design-system/lib/format'
import { decideMappingField, errorText, type MappingTarget } from './api'
import {
  choiceMaps, DECIDED_BY_WORD, decisionBody, decisionSentence, DIRECTION_WORD, DIRECTIONS, initialDraft, isLocked, LOCKED_REASON,
  requirementWord, sharedTarget, STATE_WORD, STATUS_WORD, targetLabel, transformSummary, type DecisionChoice, type DecisionDraft,
} from './model'
import styles from './files.module.css'

export type TargetsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; targets: MappingTarget[]; missingSchemas: string[] }
  | { status: 'error'; error: string }

export function DecisionDrawer({ set, row, targets, onNeedTargets, onClose, onMakeVersion, onSaved }: {
  set: MappingSetDetail
  row: MappingFieldRow
  targets: TargetsState
  onNeedTargets: () => void
  onClose: () => void
  /** Offered on a frozen version: the way to change it. */
  onMakeVersion?: () => void
  onSaved: (next: MappingSetDetail, sentence: string) => void
}) {
  const name = useId()
  const directionName = useId()
  const locked = isLocked(row)
  const editable = set.status === 'DRAFT' && !locked
  const [draft, setDraft] = useState<DecisionDraft>(() => initialDraft(row))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { body, problem } = decisionBody(row, draft)

  useEffect(() => {
    if (editable && draft.choice === 'field' && targets.status === 'idle') onNeedTargets()
  }, [editable, draft.choice, targets.status, onNeedTargets])

  const update = (patch: Partial<DecisionDraft>) => { setDraft(d => ({ ...d, ...patch })); setError(null) }

  const save = async () => {
    if (!body) return
    setSaving(true); setError(null)
    try {
      const next = await decideMappingField(set.id, body)
      onSaved(next, decisionSentence(row, body))
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  const transform = transformSummary(row.transform)
  const facts = [
    { label: 'Column in the file', value: row.columnKey ?? 'Not recorded' },
    { label: 'Channel key', value: <span className={styles.key}>{row.channelKey}</span> },
    { label: 'Requirement', value: requirementWord(row.requirement), hint: row.templateRequirement ? `Template: ${row.templateRequirement}` : undefined },
    { label: 'Decision', value: STATE_WORD[row.state] },
    { label: 'Target', value: targetLabel(row, set.channel) },
    { label: 'Transform', value: row.state === 'mapped' ? transform || 'Carried as it is' : '—' },
    { label: 'Reason', value: row.reason ?? '—' },
    { label: 'Direction', value: DIRECTION_WORD[row.direction] ?? row.direction },
    { label: 'Decided by', value: DECIDED_BY_WORD[row.decidedBy] ?? row.decidedBy },
    { label: 'Product types', value: row.productTypes.length ? row.productTypes.join(', ') : 'All product types of this form' },
    ...(row.aliases.length ? [{ label: 'Also read from', value: row.aliases.join(', ') }] : []),
  ]

  const choices: { value: DecisionChoice; title: string; description: string }[] = [
    ...(initialDraft(row).choice === 'current'
      ? [{ value: 'current' as const, title: `Keep: ${targetLabel(row, set.channel)}`, description: 'Set by the rules. This screen does not author this kind of mapping.' }]
      : []),
    { value: 'field', title: 'Map to a field', description: 'A field of the channel schema for this form.' },
    ...(set.channel === 'EBAY'
      ? [{ value: 'specific' as const, title: 'Map as an item specific', description: 'A name buyers see on eBay, outside the category schema.' }]
      : []),
    { value: 'ignored', title: 'Ignore', description: 'Not read or written. Say why.' },
    { value: 'managed', title: 'Managed elsewhere', description: 'Another Nexus workflow owns it, such as prices, stock or parentage. Say which.' },
    { value: 'unmapped', title: 'Leave unmapped', description: 'Nobody has decided. A file that fills this column is not imported.' },
  ]

  const footer = editable ? (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!body || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save decision'}</Button>
    </>
  ) : (
    <Button onClick={onClose}>Close</Button>
  )

  return (
    <Drawer open onClose={onClose} width={560} title={row.label ?? row.channelKey} subtitle={`${set.channel === 'EBAY' ? 'eBay' : 'Amazon'} ${set.marketplace} · v${set.version}`} footer={footer}>
      <div className={styles.drawerBody}>
        <KeyValue dense columns={2} items={facts} />

        {locked && <Banner tone="neutral" title="This column is locked">{LOCKED_REASON}</Banner>}
        {!locked && set.status !== 'DRAFT' && (
          <Banner tone="info" title={`v${set.version} is ${STATUS_WORD[set.status].toLowerCase()}`}
            action={onMakeVersion ? <Button size="sm" onClick={onMakeVersion}>New version from this</Button> : undefined}>
            Make a new version to change this.
          </Banner>
        )}

        {editable && (
          <>
            <fieldset className={styles.choices}>
              <legend className={styles.choicesLegend}>Decision</legend>
              {choices.map(choice => (
                <RadioCard key={choice.value} name={name} value={choice.value} variant="row"
                  checked={draft.choice === choice.value} selected={draft.choice === choice.value}
                  onChange={() => update({ choice: choice.value })}
                  title={choice.title} description={choice.description} />
              ))}
            </fieldset>

            {draft.choice === 'field' && <TargetPicker targets={targets} value={draft.targetKey} onRetry={onNeedTargets} onChange={targetKey => update({ targetKey })} />}
            {draft.choice === 'specific' && (
              <Field label="Item specific name" required hint="Spelled as buyers should see it on eBay.">
                <Input size="sm" value={draft.specificName} onChange={event => update({ specificName: event.target.value })} />
              </Field>
            )}
            {(draft.choice === 'ignored' || draft.choice === 'managed') && (
              <Field label="Reason" required hint="Shown on every import that skips this column.">
                <Textarea rows={3} value={draft.reason} onChange={event => update({ reason: event.target.value })} />
              </Field>
            )}

            {choiceMaps(draft.choice) && (
              <>
                <fieldset className={styles.choices}>
                  <legend className={styles.choicesLegend}>Direction</legend>
                  {DIRECTIONS.map(direction => (
                    <RadioCard key={direction} name={directionName} value={direction} variant="row"
                      checked={draft.direction === direction} selected={draft.direction === direction}
                      onChange={() => update({ direction })} title={DIRECTION_WORD[direction]} />
                  ))}
                </fieldset>
                <SharedTarget set={set} row={row} draft={draft} />
                <Field label="Note (optional)" hint="Kept with this decision, for example which column writes the value back.">
                  <Textarea rows={2} value={draft.reason} onChange={event => update({ reason: event.target.value })} />
                </Field>
              </>
            )}

            {problem ? <p className={styles.plain}>{problem}</p> : !body ? <p className={styles.plain}>Nothing to save: this is the current decision.</p> : null}
            {error && <Banner tone="danger" title="The decision was refused">{error}</Banner>}
          </>
        )}
      </div>
    </Drawer>
  )
}

function TargetPicker({ targets, value, onRetry, onChange }: {
  targets: TargetsState
  value: string
  onRetry: () => void
  onChange: (key: string) => void
}) {
  if (targets.status === 'error') {
    return <Banner tone="danger" title="The channel fields could not load" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>{targets.error}</Banner>
  }
  const ready = targets.status === 'ready'
  const list = ready ? targets.targets : []
  const options = list.map(t => ({
    value: t.key,
    label: `${t.englishLabel ?? t.label} · ${t.key}`,
    trailing: `${requirementWord(t.requirement)}${t.productTypes.length ? ` · ${t.productTypes.join(', ')}` : ''}`,
    searchText: [t.key, t.label, t.englishLabel ?? '', ...t.productTypes].join(' '),
  }))
  // A current target the stored schema no longer lists stays visible, and says so.
  if (value && ready && !list.some(t => t.key === value)) options.unshift({ value, label: `${value} (current; not in the stored schema)`, trailing: '', searchText: value })
  return (
    <>
      <Field label="Channel field" required hint={ready ? `${num(list.length)} fields of this form's product types.` : 'Loading the channel fields…'}>
        <Listbox size="sm" searchable searchPlaceholder="Search by name or key" placeholder={ready ? 'Choose a field' : 'Loading…'}
          disabled={!ready} value={value || undefined} options={options} onChange={onChange} />
      </Field>
      {ready && targets.missingSchemas.length > 0 && (
        <Banner tone="warning" title="Some fields are not offered">
          No channel schema is stored for {targets.missingSchemas.join(', ')}, so its fields are not in this list.
        </Banner>
      )}
      {ready && list.length === 0 && <p className={styles.plain}>No channel field is known for this form.</p>}
    </>
  )
}

/** Where several columns carry one field, say which of them writes it back — the Owner moves that here. */
function SharedTarget({ set, row, draft }: { set: MappingSetDetail; row: MappingFieldRow; draft: DecisionDraft }) {
  const kind = draft.choice === 'field' ? 'channelField' : draft.choice === 'specific' ? 'itemSpecific' : row.targetKind
  const key = draft.choice === 'field' ? draft.targetKey : draft.choice === 'specific' ? draft.specificName.trim() : row.targetKey
  const { others, writers } = sharedTarget(set.fields, { channelKey: row.channelKey, targetKind: kind, targetKey: key }, key)
  if (!key || others.length === 0) return null
  const writesToo = draft.direction !== 'in'
  const names = writers.slice(0, 3).map(w => w.label ?? w.channelKey).join(', ')
  return (
    <p className={styles.plain} role="status">
      {num(others.length)} other column{others.length === 1 ? '' : 's'} of this version also map{others.length === 1 ? 's' : ''} to {key}.{' '}
      {writers.length === 0
        ? (writesToo ? 'This column is the only one that writes it back.' : 'None of them writes it back; choose "Read and write back" on one column.')
        : `${writers.length === 1 ? 'It is' : 'They are'} written back by ${names}${writers.length > 3 ? ', …' : ''}.${writesToo ? ' This column would write it back as well.' : ''}`}
    </p>
  )
}
