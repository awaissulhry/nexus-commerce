'use client'

import { Button } from '../primitives/Button'
import { Input } from '../primitives/Input'
import { Select } from '../primitives/Select'
import { Modal } from '../components/Modal'
import { Field } from '../components/Field'
import { useRef, useState } from 'react'
import { MediaCard, MediaGallery } from '../components/MediaGallery'
import { MediaPreview } from '../components/MediaPreview'
import { MediaStrip } from '../components/MediaStrip'
import { CellAction } from '../components/CellAction'
import { PressableRow } from '../components/PressableRow'
import { Thumbnail } from '../components/Thumbnail'

// Deliberately synthetic catalog assets; no product or publishing state is implied.
const image = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="white"/><rect x="160" y="100" width="280" height="360" rx="40" fill="none" stroke="black" stroke-width="6"/><text x="300" y="520" text-anchor="middle" font-family="sans-serif" font-size="28">${label}</text></svg>`)}`

export function MediaGalleryExample() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [ids, setIds] = useState(['Front', 'Side', 'Detail'])
  const [selected, setSelected] = useState(false)
  const cell = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  return <section id="media-gallery-example">
    <h3>Control sizes stay consistent</h3><p>Normal and readable controls use the same size props. Readability changes contrast and focus only.</p>
    {[false, true].map(readable => <section key={String(readable)} className={readable ? 'nds-readable' : undefined} aria-label={readable ? 'Readable control sizes' : 'Standard control sizes'}>
      <h4>{readable ? 'Readable' : 'Standard'}</h4>
      <Button>Default action</Button> <Button size="sm">Small action</Button>
      <Field label={readable ? 'Readable input' : 'Standard input'}><Input defaultValue="Example" /></Field>
      <Field label={readable ? 'Readable select' : 'Standard select'}><Select defaultValue="example"><option value="example">Example</option></Select></Field>
    </section>)}
    <h3>Gallery navigation</h3>
    <PressableRow label="Common photos" leading={<Thumbnail src={image('Cover')} alt="" hoverPreview={false} />} current={selected} onClick={() => setSelected(true)} description="3 common photos. The first is the default cover.">3</PressableRow>
    <p>The leading thumbnail is decorative; the labelled row remains one keyboard action.</p>
    <Button size="sm" onClick={event => setAnchor(event.currentTarget)}>Open anchored editor</Button>
    <Modal open={!!anchor} anchor={anchor} title="Anchored editor" onClose={() => setAnchor(null)}><p>Anchored to its cell on desktop, centered on narrow screens. Focus and Escape follow the shared modal boundary.</p><MediaGallery compact positionControls label="Example media cell gallery" items={ids.map(id => ({id,src:image(id),label:id}))} onChange={setIds} onPreview={setPreview} /></Modal>
    <h3>Media gallery</h3><p>Synthetic images. Drag or use the labelled move controls; removing an item only changes this example.</p>
    <MediaGallery compact positionControls label="Example image order" items={ids.map(id => ({ id, src: image(id), label: id, detail: '600 × 600 px · Example asset' }))}
      onChange={setIds} onRemove={id => setIds(current => current.filter(value => value !== id))} onPreview={setPreview} />
    <p role="status">{preview ? `Inspected: ${preview}` : 'Choose an image to inspect.'}</p>
    <MediaCard label="Example document.pdf" placeholder="PDF document" onPreview={() => setPreview("Example document.pdf")} detail="No thumbnail supplied by the media provider" />
    <MediaCard src="data:image/png;base64,broken" label="Unavailable image example" selected={selected} onSelectedChange={setSelected} onPreview={() => setPreview('Unavailable image example')} />
    <h3>Grid media gestures</h3>
    <p>The cell owns keyboard focus. Thumbnails can be dragged; Enter or F2 opens the gallery's position controls. The pencil uses the same tooltip and does not begin a selection drag.</p>
    <div role="grid" aria-label="Media cell example"><div role="row"><div role="gridcell" ref={cell} tabIndex={0} className="nds-reveal-row" style={{display:'flex',alignItems:'center',gap:'var(--nds-space-8)',maxWidth:320,padding:'var(--nds-space-8)'}}
      onKeyDown={event => { if (['Enter','F2'].includes(event.key)) {event.preventDefault();setAnchor(event.currentTarget)} }}>
      <MediaStrip label="Example gallery" items={ids.map(id => ({id,type:'IMAGE',preview:image(id),alt:id}))} onReorder={setIds} onFocusCell={() => cell.current?.focus()} onOpen={() => setAnchor(cell.current)} />
      <CellAction label="Edit product media" onActivate={() => setAnchor(cell.current)} onFocusCell={() => cell.current?.focus()} />
    </div></div></div>
    <h3>Mixed media in a column</h3>
    <MediaStrip label="Example product" items={[{ id: 'photo', type: 'IMAGE', preview: image('Front') }, { id: 'video', type: 'VIDEO' }, { id: 'model', type: 'MODEL_3D' }]} />
    <MediaCard mediaType="VIDEO" label="Video without a poster" onPreview={() => setPreview('Video without a poster')} />
    <MediaPreview type="EXTERNAL_VIDEO" url="https://example.com/video" label="External video example" transcript="A translated transcript can accompany a hosted video. This is a synthetic catalog example." />
  </section>
}
