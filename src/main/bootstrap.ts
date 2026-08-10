import { app } from 'electron'
import { appendFileSync } from 'fs'

/**
 * Must be imported before any module that touches app.getPath('userData')
 * (the stores read it at module-init time).
 */
app.setName('Offshore')

if (process.env['OFFSHORE_CLEAN_PROFILE']) {
  app.setPath('userData', process.env['OFFSHORE_CLEAN_PROFILE'])
}

/**
 * Startup breadcrumbs for the dev harness. Main-process stdout does not survive
 * every launch path, so OFFSHORE_BOOT_LOG=<file> gets a synchronous trace that
 * shows exactly how far startup got before it stopped.
 */
const bootLog = process.env['OFFSHORE_BOOT_LOG']
const bootStart = Date.now()

export function boot(step: string): void {
  if (!bootLog) return
  try {
    appendFileSync(bootLog, `+${Date.now() - bootStart}ms ${step}\n`)
  } catch {
    /* tracing must never break startup */
  }
}

// Dev harness only: an uncaught throw in a main-process event handler aborts the
// process with SIGTRAP and no message. Capture it so the trace says what broke.
if (bootLog) {
  process.on('uncaughtException', (err) => {
    boot(`UNCAUGHT ${err instanceof Error ? err.stack : String(err)}`)
  })
  process.on('unhandledRejection', (err) => {
    boot(`UNHANDLED_REJECTION ${err instanceof Error ? err.stack : String(err)}`)
  })
}

boot('bootstrap')
