/**
 * Client-side logger utility for the web application
 * Provides structured logging with different severity levels
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  data?: Record<string, any>
}

class ClientLogger {
  private isDevelopment = process.env.NODE_ENV === 'development'

  private formatLog(level: LogLevel, message: string, data?: Record<string, any>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    }
  }

  private output(entry: LogEntry) {
    const prefix = `[${entry.level.toUpperCase()}]`
    const timestamp = new Date(entry.timestamp).toLocaleTimeString()

    if (this.isDevelopment) {
      const style = this.getConsoleStyle(entry.level)
      console.log(`%c${prefix} ${timestamp} ${entry.message}`, style, entry.data || '')
    }

    // In production, you could send logs to a service
    if (!this.isDevelopment && entry.level === 'error') {
      // Send error logs to monitoring service
      this.sendToMonitoring(entry)
    }
  }

  private getConsoleStyle(level: LogLevel): string {
    const styles: Record<LogLevel, string> = {
      debug: 'color: #888; font-size: 12px;',
      info: 'color: #0066cc; font-weight: bold;',
      warn: 'color: #ff9900; font-weight: bold;',
      error: 'color: #cc0000; font-weight: bold;',
    }
    return styles[level]
  }

  private sendToMonitoring(entry: LogEntry) {
    // Placeholder for sending logs to a monitoring service
    // In production, this would send to Sentry, LogRocket, etc.
  }

  debug(message: string, data?: Record<string, any>) {
    const entry = this.formatLog('debug', message, data)
    this.output(entry)
  }

  info(message: string, data?: Record<string, any>) {
    const entry = this.formatLog('info', message, data)
    this.output(entry)
  }

  warn(message: string, data?: Record<string, any>) {
    const entry = this.formatLog('warn', message, data)
    this.output(entry)
  }

  error(message: string, data?: Record<string, any>) {
    const entry = this.formatLog('error', message, data)
    this.output(entry)
  }
}

export const logger = new ClientLogger()
