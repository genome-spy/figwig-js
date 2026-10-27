import { readFileSync } from 'node:fs'

export type OracleNumber = number | 'NaN' | 'Infinity' | '-Infinity' | '-0'
export interface OracleSignal {
  positions: number[]
  values: OracleNumber[]
}
export interface OracleQuery {
  chromosome: string
  start: number
  end: number
  tracks: string[]
}
interface Summary {
  ids: number[]
  sums: OracleNumber[][]
}
export interface Oracle {
  provenance: { commit: string; querySeed: number }
  coverage: {
    chunkKinds: number[]
    elementCodes: number[]
    storedFlags: boolean[]
  }
  datasets: Record<
    string,
    {
      chromosomes: Record<
        string,
        { length: number; tracks: Record<string, OracleSignal> }
      >
      queries: OracleQuery[]
    }
  >
  files: Record<
    string,
    {
      dataset: string
      size: number
      sha256: string
      order: 'positions' | 'tracks'
      tile: number
      metadata: {
        genome: string
        attributes: Record<string, unknown>
        tracks: {
          name: string
          dtype: string
          group: number
          [key: string]: unknown
        }[]
      }
      stats: {
        sum: OracleNumber
        nonzero: OracleNumber
        min: OracleNumber
        max: OracleNumber
      }[]
      groups: {
        kinds?: number[]
        tiles?: number[]
        summary?: Summary
        zooms: (Summary & { factor: number })[]
      }[]
    }
  >
}

export const fixturePath = (name: string) =>
  new URL(`../fixtures/${name}.fw`, import.meta.url).pathname
export const oracle: Oracle = JSON.parse(
  readFileSync(new URL('../fixtures/expected.json', import.meta.url), 'utf8'),
) as Oracle

export function decodeNumber(value: OracleNumber): number {
  if (value === '-0') return -0
  return typeof value === 'number' ? value : Number(value)
}

export function expectedValues(
  dataset: string,
  chromosome: string,
  name: string,
  start: number,
  end: number,
): Float64Array {
  const result = new Float64Array(end - start)
  const signal = oracle.datasets[dataset]!.chromosomes[chromosome]!.tracks[name]
  if (signal) {
    for (let i = 0; i < signal.positions.length; i++) {
      const position = signal.positions[i]!
      if (position >= end) break
      if (position >= start)
        result[position - start] = decodeNumber(signal.values[i]!)
    }
  }
  return result
}
