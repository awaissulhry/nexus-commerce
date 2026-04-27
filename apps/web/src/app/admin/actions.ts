'use server'

const API_BASE = process.env.API_URL || 'http://localhost:3001'

export interface ValidationReport {
  isValid: boolean
  orphanedVariants: number
  inconsistentThemes: number
  missingAttributes: number
  invalidChannelListings: number
  issues: Array<{
    type: string
    severity: 'ERROR' | 'WARNING'
    message: string
    affectedIds?: string[]
  }>
}

export interface HealthStatus {
  status: 'healthy' | 'warning' | 'unhealthy'
  timestamp: string
  issues: {
    orphanedVariants: number
    inconsistentThemes: number
    missingAttributes: number
    invalidChannelListings: number
  }
  totalIssues: number
}

export interface RepairOperation {
  name: string
  description: string
  affectedCount: number
  fixedCount: number
  failedCount: number
  errors: string[]
  duration: number
}

export interface BatchRepairResult {
  success: boolean
  timestamp: string
  operations: RepairOperation[]
  summary: {
    totalAffected: number
    totalFixed: number
    totalFailed: number
  }
}

/**
 * Fetch system health status
 */
export async function getHealthStatus(): Promise<HealthStatus | null> {
  try {
    const response = await fetch(`${API_BASE}/admin/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('Failed to fetch health status:', error)
    return null
  }
}

/**
 * Fetch validation report for all products
 */
export async function getValidationReport(): Promise<ValidationReport | null> {
  try {
    const response = await fetch(`${API_BASE}/admin/validation/report`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Validation failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data.data
  } catch (error) {
    console.error('Failed to fetch validation report:', error)
    return null
  }
}

/**
 * Run all batch repair operations
 */
export async function runAllRepairs(): Promise<BatchRepairResult | null> {
  try {
    const response = await fetch(`${API_BASE}/admin/repair/all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Repair failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data.data
  } catch (error) {
    console.error('Failed to run repairs:', error)
    return null
  }
}

/**
 * Run specific repair operation
 */
export async function runRepairOperation(
  operation: 'orphaned-variations' | 'missing-themes' | 'missing-attributes' | 'product-status' | 'channel-listings'
): Promise<RepairOperation | null> {
  try {
    const response = await fetch(`${API_BASE}/admin/repair/${operation}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Repair failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data.data
  } catch (error) {
    console.error(`Failed to run ${operation} repair:`, error)
    return null
  }
}
