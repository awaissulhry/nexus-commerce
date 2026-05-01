'use client'

import { useState } from 'react'

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

  const update = (field: string, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
    onChange()
  }

  return (
    <div className="space-y-6">
      <Section
        title="Identity"
        subtitle="Core product information shared across all channels"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Master SKU" value={data.sku} onChange={(v) => update('sku', v)} mono />
          <Field label="Product Name" value={data.name} onChange={(v) => update('name', v)} />
          <Field label="Brand" value={data.brand} onChange={(v) => update('brand', v)} />
          <Field
            label="Manufacturer"
            value={data.manufacturer}
            onChange={(v) => update('manufacturer', v)}
          />
          <Field label="UPC" value={data.upc} onChange={(v) => update('upc', v)} mono />
          <Field label="EAN" value={data.ean} onChange={(v) => update('ean', v)} mono />
        </div>
      </Section>

      <Section
        title="Physical Attributes"
        subtitle="Default dimensions — variants can override"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field
            label="Weight"
            value={String(data.weightValue ?? '')}
            onChange={(v) => update('weightValue', v)}
            type="number"
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

          <Field
            label="Length"
            value={String(data.dimLength ?? '')}
            onChange={(v) => update('dimLength', v)}
            type="number"
          />
          <Field
            label="Width"
            value={String(data.dimWidth ?? '')}
            onChange={(v) => update('dimWidth', v)}
            type="number"
          />
          <Field
            label="Height"
            value={String(data.dimHeight ?? '')}
            onChange={(v) => update('dimHeight', v)}
            type="number"
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
      </Section>

      <Section
        title="Pricing Rules"
        subtitle="Master pricing constraints applied across all channels"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field
            label="Cost Price"
            value={String(data.costPrice ?? '')}
            onChange={(v) => update('costPrice', v)}
            type="number"
            prefix="€"
          />
          <Field
            label="Min Margin %"
            value={String(data.minMargin ?? '')}
            onChange={(v) => update('minMargin', v)}
            type="number"
            suffix="%"
          />
          <Field
            label="Min Price"
            value={String(data.minPrice ?? '')}
            onChange={(v) => update('minPrice', v)}
            type="number"
            prefix="€"
          />
          <Field
            label="Max Price"
            value={String(data.maxPrice ?? '')}
            onChange={(v) => update('maxPrice', v)}
            type="number"
            prefix="€"
          />
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-6">
      <h2 className="text-base font-semibold mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-slate-500 mb-4">{subtitle}</p>}
      {children}
    </div>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  mono?: boolean
  prefix?: string
  suffix?: string
}

function Field({ label, value, onChange, type = 'text', mono, prefix, suffix }: FieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-700 mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">
            {prefix}
          </span>
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            prefix ? 'pl-7' : ''
          } ${suffix ? 'pr-8' : ''} ${mono ? 'font-mono' : ''}`}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">
            {suffix}
          </span>
        )}
      </div>
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
    <div>
      <label className="block text-xs font-medium text-slate-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
