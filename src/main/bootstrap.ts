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
 * Flow tests and the screenshot harness drive a real window, but they must not
 * yank the keyboard away from whatever the human is doing. As an accessory app
 * (macOS) the harness never activates, never bounces the Dock, and leaves the
 * frontmost app exactly where it was; its window still paints and captures.
 * OFFSHORE_TEST_FOREGROUND=1 brings back the old grabby behavior when a flow
 * genuinely needs real OS focus.
 */
export const HARNESS_ACTIVE = !!(
  process.env['OFFSHORE_TEST_FLOW'] || process.env['OFFSHORE_SHOT']
)

export const HARNESS_QUIET = HARNESS_ACTIVE && !process.env['OFFSHORE_TEST_FOREGROUND']

if (HARNESS_QUIET) {
  try {
    app.setActivationPolicy('accessory')
  } catch {
    /* not macOS */
  }
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
