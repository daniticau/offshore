/// <reference lib="dom" />
import { ipcRenderer, webFrame } from 'electron'
import AutoConsent from '@duckduckgo/autoconsent'
import type { Config, ContentScriptMessage, RuleBundle } from '@duckduckgo/autoconsent'

/**
 * The content-script half of consent auto-answer. Main hands over the rules
 * (consent:rules — null when the feature is off or the site is exempt), the
 * library detects the CMP and clicks the most private choice, and everything
 * privileged funnels through two channels:
 *
 * - 'eval': CMP rules that must run in the page's main world. Primary path is
 *   webFrame.executeJavaScript from this (sandboxed) preload; if that turns
 *   out unavailable on this runtime, one IPC round-trip runs the same code in
 *   the sender's own frame (consent:eval — no privilege gained, main caps it).
 *   The code strings originate only from the bundled rules, never the page.
 * - 'consent:status': sanitized progress notes for the tab's privacy verdict.
 *
 * Everything is wrapped so a throw can never break a page.
 */
export function initConsent(): void {
  void (async () => {
    try {
      const payload = (await ipcRenderer.invoke('consent:rules')) as {
        config: Partial<Config>
        rules: RuleBundle
      } | null
      if (!payload) return

      let evalInMainWorld: (code: string) => Promise<unknown>
      try {
        if ((await webFrame.executeJavaScript('1+1')) !== 2) throw new Error('bad eval')
        evalInMainWorld = (code) => webFrame.executeJavaScript(code)
      } catch {
        evalInMainWorld = (code) => ipcRenderer.invoke('consent:eval', code)
      }

      const sendContentMessage = (msg: ContentScriptMessage): Promise<void> => {
        switch (msg.type) {
          case 'init':
            // The constructor-config shortcut is a trap in 16.22.0: initialize()
            // runs prehide before the constructor has assigned domActions. The
            // init/initResp round-trip is the supported order — deferred one
            // microtask so the constructor has returned when initialize runs.
            void Promise.resolve().then(() =>
              consent.receiveMessageCallback({
                type: 'initResp',
                config: payload.config as Config,
                rules: payload.rules
              })
            )
            break
          case 'eval':
            void evalInMainWorld(msg.code)
              .then((r) =>
                consent.receiveMessageCallback({ type: 'evalResp', id: msg.id, result: !!r })
              )
              .catch(() =>
                consent.receiveMessageCallback({ type: 'evalResp', id: msg.id, result: false })
              )
            break
          case 'optOutResult':
            ipcRenderer.send('consent:status', { type: msg.type, cmp: msg.cmp, result: msg.result })
            if (msg.scheduleSelfTest) {
              setTimeout(() => void consent.receiveMessageCallback({ type: 'selfTest' }), 500)
            }
            break
          case 'cmpDetected':
          case 'popupFound':
          case 'autoconsentDone':
            ipcRenderer.send('consent:status', { type: msg.type, cmp: msg.cmp })
            break
          case 'autoconsentError':
            ipcRenderer.send('consent:status', { type: msg.type })
            break
          // 'report', 'visualDelay', 'selfTestResult', 'optInResult': ignore
        }
        return Promise.resolve()
      }

      const consent = new AutoConsent(sendContentMessage, null, null)
    } catch (err) {
      // consent must never break a page — but a real fault must not vanish either
      console.warn('[consent] init failed:', err)
    }
  })()
}
