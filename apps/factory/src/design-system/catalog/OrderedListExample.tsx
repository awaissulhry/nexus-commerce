'use client'

import { useState } from 'react'
import { OrderedList } from '../components/OrderedList'

export function OrderedListExample() {
  const [items, setItems] = useState(['Colour', 'Size', 'Length'])
  return <section id="ordered-list-example">
    <h3>OrderedList</h3>
    <p>Drag the grip or use the labelled up/down buttons. Moving an item preserves its content and announces its new position. Product variations consume this same control.</p>
    <p>For resource IDs, pass itemLabel to name controls and announcements with the product title. renderItem controls the visible content independently.</p>
    <OrderedList label="Example variation axis order" items={items} onChange={setItems} />
  </section>
}
