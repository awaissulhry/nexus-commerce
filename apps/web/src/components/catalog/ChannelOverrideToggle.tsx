'use client'

import { useState } from 'react'
import SyncStatusIcon from './SyncStatusIcon'

interface ChannelOverrideToggleProps {
  label: string
  masterValue: string | number | null
  overrideValue?: string | number | null
  isFollowingMaster: boolean
  onToggle: (isFollowing: boolean) => void
  onChange: (value: string | number) => void
  syncStatus?: 'IDLE' | 'PENDING' | 'SYNCING' | 'IN_SYNC' | 'FAILED'
  lastSyncAt?: Date | null
  inputType?: 'text' | 'number' | 'email' | 'url'
  placeholder?: string
}

export default function ChannelOverrideToggle({
  label,
  masterValue,
  overrideValue,
  isFollowingMaster,
  onToggle,
  onChange,
  syncStatus = 'IDLE',
  lastSyncAt,
  inputType = 'text',
  placeholder,
}: ChannelOverrideToggleProps) {
  const [localValue, setLocalValue] = useState<string | number>(overrideValue ?? '')

  const handleToggle = () => {
    onToggle(!isFollowingMaster)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = inputType === 'number' ? parseFloat(e.target.value) || '' : e.target.value
    setLocalValue(value)
    onChange(value)
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
      {/* Header: Label + Sync Status */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
        {syncStatus && <SyncStatusIcon status={syncStatus} lastSyncAt={lastSyncAt} />}
      </div>

      {/* Master Value Display */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-gray-500 mb-1">Master SSOT</label>
        <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 border border-gray-200 font-mono">
          {masterValue !== null && masterValue !== undefined ? String(masterValue) : '—'}
        </div>
      </div>

      {/* Toggle Switch */}
      <div className="mb-4 flex items-center justify-between rounded-md bg-gray-50 p-3">
        <span className="text-xs font-medium text-gray-700">
          {isFollowingMaster ? 'Follow Master' : 'Custom Override'}
        </span>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            isFollowingMaster ? 'bg-green-600' : 'bg-blue-600'
          }`}
          aria-label={`Toggle ${label} override`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              isFollowingMaster ? 'translate-x-1' : 'translate-x-6'
            }`}
          />
        </button>
      </div>

      {/* Custom Override Input (Conditional) */}
      {!isFollowingMaster && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
          <label className="block text-xs font-medium text-gray-700 mb-2">Custom Value</label>
          <input
            type={inputType}
            value={localValue}
            onChange={handleInputChange}
            placeholder={placeholder || `Enter custom ${label.toLowerCase()}`}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <p className="mt-2 text-xs text-gray-500">
            This value will override the master data for this channel.
          </p>
        </div>
      )}

      {/* Info Badge */}
      <div className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700 border border-blue-200">
        {isFollowingMaster ? (
          <>
            <span className="font-medium">Synced with Master:</span> Changes to the master {label.toLowerCase()} will automatically update this channel.
          </>
        ) : (
          <>
            <span className="font-medium">Custom Override Active:</span> This channel uses a custom {label.toLowerCase()} independent of the master.
          </>
        )}
      </div>
    </div>
  )
}
