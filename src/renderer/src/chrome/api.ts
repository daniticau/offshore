import type { OffshoreApi } from '@shared/bridge'

/** The chrome UI's bridge, exposed by src/preload/index.ts and typed with it. */
export const offshore = (window as unknown as { offshore: OffshoreApi }).offshore

export { prettyHost } from '@shared/url'
