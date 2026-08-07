import { app } from 'electron'

/**
 * Must be imported before any module that touches app.getPath('userData')
 * (the stores read it at module-init time).
 */
app.setName('Offshore')

if (process.env['OFFSHORE_CLEAN_PROFILE']) {
  app.setPath('userData', process.env['OFFSHORE_CLEAN_PROFILE'])
}
