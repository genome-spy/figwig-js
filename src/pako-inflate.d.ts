// Pako exposes this subpath, but @types/pako declares only the package root.
declare module 'pako/lib/inflate.js' {
  export { Inflate } from 'pako'
}
