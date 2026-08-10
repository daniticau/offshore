/// <reference types="vite/client" />

// Asset imports resolved by Vite (the icon art, bundled fonts, and friends).
declare module '*.png' {
  const src: string
  export default src
}
