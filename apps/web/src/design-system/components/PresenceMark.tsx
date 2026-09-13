import { Tag } from '../primitives/Tag'
import { Pill } from '../primitives/Pill'
import { InfoTip } from '../primitives/InfoTip'
import { AsOf } from './AsOf'
import { presenceLine, type Presence } from '../grid/renderers/presence'
export type PresenceMarkProps = { via?: string | null; axis?: 'intent' | 'fact' | 'both'; compact?: boolean } & (
  | { presence: Presence; line?: ReturnType<typeof presenceLine>; now?: never }
  | { line: ReturnType<typeof presenceLine>; now: number; presence?: never }
)
/** Intent and observation remain separate. A canonical aggregate line needs no invented member. */
export function PresenceMark(props: PresenceMarkProps) {
  const { via, axis = 'both', compact = false } = props
  const line = props.presence ? props.line ?? presenceLine(props.presence) : props.line
  const now = props.presence ? props.presence.now : props.now
  const unknownSource = props.line == null && via === null && props.presence?.fact !== 'REFUSED'
  return <span className="nds-presence-mark">
    {axis !== 'fact' && <Tag tone={line.intent.tone}>{line.intent.label}</Tag>}
    {axis !== 'intent' && <>
      <Pill tone={unknownSource ? 'neutral' : line.fact.tone} dot>{unknownSource ? 'Not checked' : line.fact.label}</Pill>
      <AsOf at={line.asOf} via={via} now={now} />
    </>}
    {compact
      ? <InfoTip tip={unknownSource ? `${line.intent.label}. The observation source is not known.` : line.sentence} />
      : <span className="nds-presence-sentence">{props.line?.sentence ?? (unknownSource ? 'The observation source is not known.' : line.verdict.sentence)}</span>}
  </span>
}
