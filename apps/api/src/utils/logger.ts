/**
 * Logger Utility
 * Provides structured logging for the API
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, any>;
}

class Logger {
  private isDevelopment = process.env.NODE_ENV !== 'production';

  private formatLog(level: LogLevel, message: string, context?: Record<string, any>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context
    };
  }

  private output(entry: LogEntry): void {
    const logString = JSON.stringify(entry);

    switch (entry.level) {
      case 'debug':
        if (this.isDevelopment) {
          console.debug(logString);
        }
        break;
      case 'info':
        console.info(logString);
        break;
      case 'warn':
        console.warn(logString);
        break;
      case 'error':
        console.error(logString);
        break;
    }
  }

  debug(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('debug', message, context);
    this.output(entry);
  }

  info(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('info', message, context);
    this.output(entry);
  }

  warn(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('warn', message, context);
    this.output(entry);
  }

  error(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('error', message, context);
    this.output(entry);
  }
}

export const logger = new Logger();
