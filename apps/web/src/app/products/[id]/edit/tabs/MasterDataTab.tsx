'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'

interface Props {
  product: any
  onChange: () => void
}

export default function MasterDataTab({ product, onChange }: Props) {
  const [data, setData] = useState({
    sku: product.sku ?? '',
    name: product.name ?? '',
    brand: product.brand ?? '',
    manufacturer: product.manufacturer ?? '',
    upc: product.upc ?? '',
    ean: product.ean ?? '',
    weightValue: product.weightValue ?? '',
    weightUnit: product.weightUnit ?? 'kg',
    dimLength: product.dimLength ?? '',
    dimWidth: product.dimWidth ?? '',
    dimHeight: product.dimHeight ?? '',
    dimUnit: product.dimUnit ?? 'cm',
    costPrice: product.costPrice ?? '',
    minMargin: product.minMargin ?? '',
    minPrice: product.minPrice ?? '',
    maxPrice: product.maxPrice ?? '',
  })

  const update = (field: keyof typeof data, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    onChange()
  }

  return (
    <div className="space-y-4">
      <Card title="Identity" description="Core information shared across all channels">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
          <Input
            label="Master SKU"
            value={data.sku}
            mono
            onChange={(e) => update('sku', e.target.value)}
          />
          <Input
            label="Product Name"
            value={data.name}
            onChange={(e) => update('name', e.target.value)}
          />
          <Input
            label="Brand"
            value={data.brand}
            onChange={(e) => update('brand', e.target.value)}
          />
          <Input
            label="Manufacturer"
            value={data.manufacturer}
            onChange={(e) => update('manufacturer', e.target.value)}
          />
          <Input
            label="UPC"
            value={data.upc}
            mono
            onChange={(e) => update('upc', e.target.value)}
          />
          <Input
            label="EAN"
            value={data.ean}
            mono
            onChange={(e) => update('ean', e.target.value)}
          />
        </div>
      </Card>

      <Card title="Physical Attributes" description="Defaults for fulfillment fees and shipping. Variants can override.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label="Weight"
            type="number"
            value={String(data.weightValue ?? '')}
            onChange={(e) => update('weightValue', e.target.value)}
          />
          <SelectField
            label="Unit"
            value={data.weightUnit}
            onChange={(v) => update('weightUnit', v)}
            options={[
              { value: 'kg', label: 'kg' },
              { value: 'g', label: 'g' },
              { value: 'lb', label: 'lb' },
              { value: 'oz', label: 'oz' },
            ]}
          />
          <div />
          <div />
          <Input
            label="Length"
            type="number"
            value={String(data.dimLength ?? '')}
            onChange={(e) => update('dimLength', e.target.value)}
          />
          <Input
            label="Width"
            type="number"
            value={String(data.dimWidth ?? '')}
            onChange={(e) => update('dimWidth', e.target.value)}
          />
          <Input
            label="Height"
            type="number"
            value={String(data.dimHeight ?? '')}
            onChange={(e) => update('dimHeight', e.target.value)}
          />
          <SelectField
            label="Unit"
            value={data.dimUnit}
            onChange={(v) => update('dimUnit', v)}
            options={[
              { value: 'cm', label: 'cm' },
              { value: 'mm', label: 'mm' },
              { value: 'in', label: 'in' },
            ]}
          />
        </div>
      </Card>

      <Card title="Pricing Rules" description="Constraints applied across all channels">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
          <Input
            label="Cost Price"
            type="number"
            prefix="€"
            value={String(data.costPrice ?? '')}
            onChange={(e) => update('costPrice', e.target.value)}
          />
          <Input
            label="Min Margin"
            type="number"
            suffix="%"
            value={String(data.minMargin ?? '')}
            onChange={(e) => update('minMargin', e.target.value)}
          />
          <Input
            label="Min Price"
            type="number"
            prefix="€"
            value={String(data.minPrice ?? '')}
            onChange={(e) => update('minPrice', e.target.value)}
          />
          <Input
            label="Max Price"
            type="number"
            prefix="€"
            value={String(data.maxPrice ?? '')}
            onChange={(e) => update('maxPrice', e.target.value)}
          />
        </div>
      </Card>
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <div className="space-y-1">
      <label className="text-[12px] font-medium text-slate-700">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded-md border border-slate-200 hover:border-slate-300 bg-white text-[13px] text-slate-900 px-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
