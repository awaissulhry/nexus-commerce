'use client'

import { useState, useCallback, useRef } from 'react'
import ExcelJS from 'exceljs'
// TECH_DEBT #6 — swapped from `xlsx` (npm 0.18.5, CVE-2023-30533)
// to `exceljs` (MIT, actively maintained). Drops .xls (legacy
// BIFF) support — modern xlsx is universally available, .xls
// users get a clear error with re-save instructions.
import { getBackendUrl } from '@/lib/backend-url'

// ── Types ────────────────────────────────────────────────────────────────────

interface ParsedRow {
  rowIndex: number
  sku: string
  name: string
  basePrice: number
  totalStock: number
  upc: string
  ean: string
  brand: string
  manufacturer: string
  errors: string[]
  warnings: string[]
}

interface ImportResult {
  processed: number
  successful: number
  failed: number
  results: Array<{
    sku: string
    status: 'created' | 'updated' | 'failed'
    message?: string
  }>
}

type UploadStage = 'upload' | 'preview' | 'importing' | 'complete'

// ── Validation helpers ───────────────────────────────────────────────────────

function validateRow(row: Record<string, any>, rowIndex: number, seenSkus: Set<string>): ParsedRow {
  const errors: string[] = []
  const warnings: string[] = []

  const sku = String(row['SKU'] || row['sku'] || '').trim()
  const name = String(row['Title'] || row['Name'] || row['name'] || row['title'] || '').trim()
  const basePrice = parseFloat(row['Price'] || row['BasePrice'] || row['basePrice'] || row['price'] || '0')
  const totalStock = parseInt(row['Stock'] || row['TotalStock'] || row['totalStock'] || row['stock'] || row['Quantity'] || row['quantity'] || '0', 10)
  const upc = String(row['UPC'] || row['upc'] || '').trim()
  const ean = String(row['EAN'] || row['ean'] || '').trim()
  const brand = String(row['Brand'] || row['brand'] || '').trim()
  const manufacturer = String(row['Manufacturer'] || row['manufacturer'] || '').trim()

  // Required fields
  if (!sku) errors.push('SKU is required')
  if (!name) errors.push('Title is required')

  // Price validation
  if (isNaN(basePrice) || basePrice <= 0) errors.push('Price must be greater than 0')

  // Stock validation
  if (isNaN(totalStock) || totalStock < 0) warnings.push('Stock is negative or invalid')

  // UPC format (12 digits)
  if (upc && !/^\d{12}$/.test(upc)) errors.push('UPC must be exactly 12 digits')

  // EAN format (13 digits)
  if (ean && !/^\d{13}$/.test(ean)) errors.push('EAN must be exactly 13 digits')

  // Duplicate SKU within file
  if (sku && seenSkus.has(sku)) {
    errors.push(`Duplicate SKU "${sku}" in file`)
  }
  if (sku) seenSkus.add(sku)

  // Warnings
  if (!brand) warnings.push('Brand is empty')
  if (totalStock === 0) warnings.push('Stock is zero')

  return {
    rowIndex,
    sku,
    name,
    basePrice: isNaN(basePrice) ? 0 : basePrice,
    totalStock: isNaN(totalStock) ? 0 : totalStock,
    upc,
    ean,
    brand,
    manufacturer,
    errors,
    warnings,
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function InventoryUploadPage() {
  const [stage, setStage] = useState<UploadStage>('upload')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [fileName, setFileName] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const errorCount = rows.filter((r) => r.errors.length > 0).length
  const validCount = rows.filter((r) => r.errors.length === 0).length

  // ── File parsing ─────────────────────────────────────────────────────────

  const parseFile = useCallback((file: File) => {
    setFileName(file.name)
    if (file.name.toLowerCase().endsWith('.xls')) {
      setImportError(
        'Legacy .xls files are not supported. Please re-save your spreadsheet as .xlsx and try again.',
      )
      return
    }
    const reader = new FileReader()

    reader.onload = async (e) => {
      try {
        const data = e.target?.result as ArrayBuffer
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(data)
        const sheet = workbook.worksheets[0]
        if (!sheet) {
          setImportError('The file has no sheets')
          return
        }

        // Build header → column-index lookup from row 1.
        const headerRow = sheet.getRow(1)
        const headers: string[] = []
        headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const v = cell.value
          headers[colNumber - 1] =
            v == null ? '' :
            typeof v === 'object' && 'text' in (v as any) ? String((v as any).text).trim() :
            typeof v === 'object' && 'result' in (v as any) ? String((v as any).result ?? '').trim() :
            String(v).trim()
        })

        // Iterate rows 2+ → header-keyed objects mirroring the
        // shape `xlsx.utils.sheet_to_json` returned.
        const jsonData: Record<string, any>[] = []
        const lastRow = sheet.actualRowCount ?? sheet.rowCount
        for (let r = 2; r <= lastRow; r++) {
          const row = sheet.getRow(r)
          if (row.actualCellCount === 0) continue
          const obj: Record<string, any> = {}
          row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            const h = headers[colNumber - 1]
            if (!h) return
            const v = cell.value
            obj[h] =
              v == null ? '' :
              v instanceof Date ? v.toISOString() :
              typeof v === 'object' && 'text' in (v as any) ? (v as any).text :
              typeof v === 'object' && 'result' in (v as any) ? (v as any).result :
              v
          })
          jsonData.push(obj)
        }

        if (jsonData.length === 0) {
          setImportError('The file contains no data rows')
          return
        }

        const seenSkus = new Set<string>()
        const parsed = jsonData.map((row, idx) => validateRow(row, idx + 2, seenSkus)) // +2 for 1-indexed + header

        setRows(parsed)
        setStage('preview')
        setImportError(null)
      } catch (err) {
        setImportError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    reader.readAsArrayBuffer(file)
  }, [])

  // ── Drag & Drop handlers ─────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) parseFile(file)
    },
    [parseFile]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) parseFile(file)
    },
    [parseFile]
  )

  // ── Import handler ───────────────────────────────────────────────────────

  const handleImport = async () => {
    const validRows = rows.filter((r) => r.errors.length === 0)
    if (validRows.length === 0) return

    setStage('importing')
    setImportError(null)

    try {
      const items = validRows.map((r) => ({
        sku: r.sku,
        name: r.name,
        basePrice: r.basePrice,
        totalStock: r.totalStock,
        upc: r.upc || undefined,
        ean: r.ean || undefined,
        brand: r.brand || undefined,
        manufacturer: r.manufacturer || undefined,
      }))

      const apiBase = getBackendUrl()
      const response = await fetch(`${apiBase}/inventory/bulk-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || `Server error: ${response.status}`)
      }

      const result: ImportResult = await response.json()
      setImportResult(result)
      setStage('complete')
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
      setStage('preview')
    }
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  const handleReset = () => {
    setStage('upload')
    setRows([])
    setFileName('')
    setImportResult(null)
    setImportError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Inventory Upload</h1>
          <p className="text-gray-600 mt-1">
            Import products from Excel or CSV files
          </p>
        </div>
        {stage !== 'upload' && (
          <button
            type="button"
            onClick={handleReset}
            className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
          >
            ↩ Start Over
          </button>
        )}
      </div>

      {/* Error banner */}
      {importError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800 font-medium">⚠️ {importError}</p>
        </div>
      )}

      {/* ── Stage: Upload ─────────────────────────────────────────────────── */}
      {stage === 'upload' && (
        <div>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-300 bg-white hover:border-gray-400 hover:bg-gray-50'
            }`}
          >
            <div className="text-5xl mb-4">{isDragging ? '📥' : '📄'}</div>
            <p className="text-lg font-semibold text-gray-700 mb-2">
              {isDragging ? 'Drop your file here' : 'Drag & drop your inventory file'}
            </p>
            <p className="text-sm text-gray-500 mb-4">
              Supports .xlsx, .xls, and .csv files
            </p>
            <button
              type="button"
              className="px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm"
            >
              Browse Files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* Template info */}
          <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">📋 Expected Columns</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-blue-800">
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">SKU *</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">Title *</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">Price *</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">Stock</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">UPC</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">EAN</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">Brand</span>
              <span className="font-mono bg-blue-100 px-2 py-1 rounded">Manufacturer</span>
            </div>
            <p className="text-xs text-blue-700 mt-2">* Required fields</p>
          </div>
        </div>
      )}

      {/* ── Stage: Preview ────────────────────────────────────────────────── */}
      {stage === 'preview' && (
        <div>
          {/* Summary bar */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">File</p>
              <p className="text-lg font-bold text-gray-900 truncate">{fileName}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Total Rows</p>
              <p className="text-2xl font-bold text-gray-900">{rows.length}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Valid</p>
              <p className="text-2xl font-bold text-green-600">{validCount}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-600">Errors</p>
              <p className="text-2xl font-bold text-red-600">{errorCount}</p>
            </div>
          </div>

          {/* Preview table */}
          <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase w-12">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Row
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      SKU
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Title
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Price
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Stock
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      UPC
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                      Issues
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => {
                    const hasErrors = row.errors.length > 0
                    const hasWarnings = row.warnings.length > 0

                    return (
                      <tr
                        key={row.rowIndex}
                        className={
                          hasErrors
                            ? 'bg-red-50'
                            : hasWarnings
                              ? 'bg-yellow-50'
                              : 'hover:bg-gray-50'
                        }
                      >
                        <td className="px-4 py-3 text-center">
                          {hasErrors ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-600 text-xs font-bold" title="Error">
                              ✗
                            </span>
                          ) : hasWarnings ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-100 text-yellow-600 text-xs font-bold" title="Warning">
                              !
                            </span>
                          ) : (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-600 text-xs font-bold" title="Valid">
                              ✓
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">{row.rowIndex}</td>
                        <td className="px-4 py-3 text-sm font-mono text-gray-900">
                          {row.sku || <span className="text-red-400 italic">missing</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 max-w-xs truncate">
                          {row.name || <span className="text-red-400 italic">missing</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {row.basePrice > 0 ? `$${row.basePrice.toFixed(2)}` : <span className="text-red-400">$0.00</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">{row.totalStock}</td>
                        <td className="px-4 py-3 text-sm font-mono text-gray-600">
                          {row.upc || '—'}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {row.errors.map((err, i) => (
                            <span key={`e-${i}`} className="block text-red-600">🔴 {err}</span>
                          ))}
                          {row.warnings.map((warn, i) => (
                            <span key={`w-${i}`} className="block text-yellow-600">🟡 {warn}</span>
                          ))}
                          {!hasErrors && !hasWarnings && (
                            <span className="text-green-600">🟢 Ready</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Import button */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {validCount} of {rows.length} rows will be imported
              {errorCount > 0 && (
                <span className="text-red-600 ml-1">({errorCount} skipped due to errors)</span>
              )}
            </p>
            <button
              type="button"
              onClick={handleImport}
              disabled={validCount === 0}
              className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-semibold"
            >
              📤 Import {validCount} Product{validCount !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {/* ── Stage: Importing ──────────────────────────────────────────────── */}
      {stage === 'importing' && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4 animate-bounce">📦</div>
          <p className="text-lg font-semibold text-gray-700">Importing products…</p>
          <p className="text-sm text-gray-500 mt-2">
            Processing {validCount} items. Please wait.
          </p>
        </div>
      )}

      {/* ── Stage: Complete ───────────────────────────────────────────────── */}
      {stage === 'complete' && importResult && (
        <div>
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white rounded-xl shadow-lg p-6 border-l-4 border-blue-500">
              <p className="text-sm text-gray-600 mb-1">Processed</p>
              <p className="text-4xl font-bold text-gray-900">{importResult.processed}</p>
            </div>
            <div className="bg-white rounded-xl shadow-lg p-6 border-l-4 border-green-500">
              <p className="text-sm text-gray-600 mb-1">Successful</p>
              <p className="text-4xl font-bold text-green-600">{importResult.successful}</p>
            </div>
            <div className="bg-white rounded-xl shadow-lg p-6 border-l-4 border-red-500">
              <p className="text-sm text-gray-600 mb-1">Failed</p>
              <p className="text-4xl font-bold text-red-600">{importResult.failed}</p>
            </div>
          </div>

          {/* Results table */}
          <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                    SKU
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-600 uppercase">
                    Message
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {importResult.results.map((r, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-6 py-3 text-sm font-mono text-gray-900">{r.sku}</td>
                    <td className="px-6 py-3 text-sm">
                      {r.status === 'created' && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                          ✓ Created
                        </span>
                      )}
                      {r.status === 'updated' && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
                          ↻ Updated
                        </span>
                      )}
                      {r.status === 'failed' && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                          ✗ Failed
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-600">{r.message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleReset}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              📤 Upload Another File
            </button>
            <a
              href="/catalog"
              className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
            >
              📦 View Catalog
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
