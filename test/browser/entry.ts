import { BlobFile, RemoteFile } from 'generic-filehandle2'
import { FigWig } from '../../src/index.js'

declare global {
  interface Window {
    FigWig: typeof FigWig
    RemoteFile: typeof RemoteFile
    BlobFile: typeof BlobFile
    figwigReader?: FigWig
  }
}

Object.assign(window, { FigWig, RemoteFile, BlobFile })
