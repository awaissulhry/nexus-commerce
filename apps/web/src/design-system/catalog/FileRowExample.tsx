'use client'
import { useState } from 'react'
import { FileDropzone } from '../components/FileDropzone'
import { FileRow } from '../components/FileRow'

const PICKED = { name: 'nexus-products-2026-09-26-italy-germany-france-spain-all-fields.xlsx', size: 689_152 }

export function FileRowExample() {
  const [file, setFile] = useState<{ name: string; size: number } | null>(PICKED)
  return <section id="file-row-example"><h3>FileRow</h3>
    <p>The one file an operator picked, in place of the FileDropzone. A long name truncates and shows in full on hover. Remove returns to the dropzone; both actions are 28px and are described by the file name.</p>
    {file
      ? <FileRow name={file.name} size={file.size} status="Nexus file · 42 products" onReplace={() => setFile({ name: 'nexus-products-replacement.xlsx', size: 1_887_437 })} onRemove={() => setFile(null)} />
      : <FileDropzone accept=".xlsx,.csv,.zip" onFiles={([picked]) => setFile({ name: picked.name, size: picked.size })} />}
    <p>While the file is read, the actions are locked and the status counts seconds.</p>
    <FileRow name="catalog-export.zip" size={12_400_000} status="Reading… 3 s" onReplace={() => {}} onRemove={() => {}} disabled />
    <p>A refused file keeps its reason as text; the danger role is never the only signal.</p>
    <FileRow name="notes.txt" size={999} tone="danger" status="Not a Nexus product file. Export one from Products, then try again." onReplace={() => {}} onRemove={() => {}} />
  </section>
}
