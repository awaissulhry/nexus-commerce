import { EditModeBar } from '@nexus/design-system'

/** The default message is built from `count` — the unsaved-edit state of an inline-editable grid. */
export const UnsavedChanges = () => <EditModeBar count={7} onDiscard={() => {}} onApply={() => {}} />

/** One change reads in the singular; `applyLabel` names what Apply will actually do. */
export const SingleChange = () => (
  <EditModeBar count={1} applyLabel="Apply bid change" onDiscard={() => {}} onApply={() => {}} />
)

/** `message` replaces the count entirely when the edit needs spelling out. */
export const CustomMessage = () => (
  <EditModeBar
    message={
      <>
        <b>41</b> bids staged · €0.42 → €0.51 average, +€86/day at the current pace
      </>
    }
    applyLabel="Push to Amazon"
    onDiscard={() => {}}
    onApply={() => {}}
  />
)

/** `busy` holds both buttons while the write is in flight, so a double-apply is impossible. */
export const Busy = () => (
  <EditModeBar count={41} applyLabel="Pushing to Amazon…" busy onDiscard={() => {}} onApply={() => {}} />
)
