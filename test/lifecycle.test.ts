import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { BlobFile } from 'generic-filehandle2'
import type { GenericFilehandle } from 'generic-filehandle2'
import { expect, test } from 'vitest'
import { FigWig } from '../src/index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function gate() {
  return { entered: deferred(), release: deferred(), finished: deferred() }
}

/** A real Blob handle whose blocked read/stat deliberately ignores aborts. */
function controlledHandle() {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/zlib.fw', import.meta.url)),
  )
  const underlying = new BlobFile(new Blob([bytes]))
  const state = {
    reads: 0,
    stats: 0,
    closes: 0,
    nextRead: undefined as ReturnType<typeof gate> | undefined,
    nextStat: undefined as ReturnType<typeof gate> | undefined,
    closeGate: undefined as ReturnType<typeof gate> | undefined,
    closeError: undefined as Error | undefined,
    signals: [] as (AbortSignal | undefined)[],
  }
  const filehandle: GenericFilehandle = {
    read: async (length, position, options) => {
      state.reads++
      state.signals.push(options?.signal)
      const paused = state.nextRead
      state.nextRead = undefined
      if (paused) {
        paused.entered.resolve()
        await paused.release.promise
      }
      try {
        // Do not pass the signal: the reader must reject and stay closed even
        // when a supplied handle cannot interrupt its underlying operation.
        return await underlying.read(length, position)
      } finally {
        paused?.finished.resolve()
      }
    },
    stat: async () => {
      state.stats++
      const paused = state.nextStat
      state.nextStat = undefined
      if (paused) {
        paused.entered.resolve()
        await paused.release.promise
      }
      try {
        return await underlying.stat()
      } finally {
        paused?.finished.resolve()
      }
    },
    close: async () => {
      state.closes++
      if (state.closeGate) {
        state.closeGate.entered.resolve()
        await state.closeGate.release.promise
      }
      if (state.closeError) throw state.closeError
      await underlying.close()
    },
    readFile: underlying.readFile.bind(underlying),
  }
  return { filehandle, state }
}

async function promptly<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('A closed reader left its query pending')),
          1000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

test.each(['header', 'stat', 'index', 'data'] as const)(
  'closing during %s loading promptly cancels the query and prevents late cache fills',
  async (stage) => {
    const { filehandle, state } = controlledHandle()
    const reader = new FigWig({ filehandle })
    if (stage === 'index') await reader.getHeader()
    if (stage === 'data') await reader.getZoomLevels({ tracks: ['signal'] })
    const paused = gate()
    if (stage === 'stat') state.nextStat = paused
    else state.nextRead = paused
    const query = reader.getValues('chr1', 0, 100, { tracks: ['signal'] })
    // Observe rejection immediately, before triggering close().
    const outcome = query.then(
      () => ({ name: 'unexpected success' }),
      (error: Error) => error,
    )
    try {
      await paused.entered.promise
      const reads = state.reads
      const stats = state.stats
      await reader.close()
      expect(await promptly(outcome)).toHaveProperty('name', 'AbortError')
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
      expect(state.closes).toBe(1)
      if (stage !== 'stat') expect(state.signals.at(-1)?.aborted).toBe(true)
      paused.release.resolve()
      await paused.finished.promise
      await setImmediate()
      expect(state.reads).toBe(reads)
      expect(state.stats).toBe(stats)
      expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      paused.release.resolve()
      await outcome
      await reader.close()
    }
  },
)

test('close prevents queued group reads from starting after the active read finishes', async () => {
  const { filehandle, state } = controlledHandle()
  const reader = new FigWig({
    filehandle,
    maxConcurrentRequests: 1,
    maxCoalescedBytes: 1,
  })
  const header = await reader.getHeader()
  const tracks = [
    ...new Map(
      header.tracks.map((track) => [track.group, track.name]),
    ).values(),
  ].slice(0, 2)
  expect(tracks).toHaveLength(2)
  const paused = gate()
  state.nextRead = paused
  const outcome = reader.getValues('chr1', 0, 100, { tracks }).then(
    () => ({ name: 'unexpected success' }),
    (error: Error) => error,
  )
  try {
    await paused.entered.promise
    const reads = state.reads
    await reader.close()
    expect(await promptly(outcome)).toHaveProperty('name', 'AbortError')
    paused.release.resolve()
    await paused.finished.promise
    await setImmediate()
    expect(state.reads).toBe(reads)
    expect(reader.getDiagnostics().cacheBytes).toBe(0)
  } finally {
    paused.release.resolve()
    await outcome
    await reader.close()
  }
})

test('all query methods reject after close without accessing the filehandle', async () => {
  const { filehandle, state } = controlledHandle()
  const reader = new FigWig({ filehandle })
  await reader.close()
  const queries = [
    () => reader.getHeader(),
    () => reader.getTracks(),
    () => reader.selectTracks([]),
    () => reader.getValues('chr1', 0, 1),
    () => reader.getValuesMulti([]),
    () => reader.getBins('chr1', 0, 1, { binSize: 1 }),
    () => reader.getBinsMulti([], { binSize: 1 }),
    () => reader.getFeatures('chr1', 0, 1),
    () => reader.getFeaturesMulti([]),
    () => reader.getSummary(0),
    () => reader.getZoomLevels(),
  ]
  for (const query of queries) {
    const outcome = query().then(
      () => ({ name: 'unexpected success' }),
      (error: Error) => error,
    )
    expect(await outcome).toHaveProperty('name', 'AbortError')
  }
  reader.clearCache()
  reader.resetDiagnostics()
  expect(reader.getDiagnostics().cacheBytes).toBe(0)
  expect(state.reads).toBe(0)
  expect(state.stats).toBe(0)
  expect(state.closes).toBe(1)
})

test('a cached query pending at close rejects and completed output arrays remain usable', async () => {
  const { filehandle } = controlledHandle()
  const reader = new FigWig({ filehandle })
  const values = (
    await reader.getValues('chr1', 0, 100, { tracks: ['signal'] })
  ).tracks[0].values
  const expected = Array.from(values)
  const outcome = reader.getHeader().then(
    () => ({ name: 'unexpected success' }),
    (error: Error) => error,
  )
  await reader.close()
  expect(await outcome).toHaveProperty('name', 'AbortError')
  expect(Array.from(values)).toEqual(expected)
  expect(reader.getDiagnostics().cacheBytes).toBe(0)
})

test.each([false, true])(
  'concurrent and repeated close calls share one filehandle close (failure: %s)',
  async (fails) => {
    const { filehandle, state } = controlledHandle()
    const reader = new FigWig({ filehandle })
    const paused = gate()
    state.closeGate = paused
    if (fails) state.closeError = new Error('filehandle close failed')
    const first = reader.close()
    const second = reader.close()
    const outcomes = Promise.allSettled([first, second])
    await paused.entered.promise
    const concurrentCloses = state.closes
    paused.release.resolve()
    const settled = await outcomes
    expect(concurrentCloses).toBe(1)
    expect(settled.map((result) => result.status)).toEqual(
      fails ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
    )
    if (fails) {
      expect(settled).toEqual([
        { status: 'rejected', reason: state.closeError },
        { status: 'rejected', reason: state.closeError },
      ])
      await expect(reader.close()).rejects.toBe(state.closeError)
    } else await reader.close()
    expect(state.closes).toBe(1)
    await expect(reader.getHeader()).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(state.reads).toBe(0)
  },
)

test('a synchronous filehandle close failure is memoized without retrying disposal', async () => {
  const { filehandle, state } = controlledHandle()
  const failure = new Error('synchronous close failure')
  filehandle.close = () => {
    state.closes++
    throw failure
  }
  const reader = new FigWig({ filehandle })
  const outcomes = await Promise.allSettled([reader.close(), reader.close()])
  expect(outcomes).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ])
  await expect(reader.close()).rejects.toBe(failure)
  expect(state.closes).toBe(1)
  await expect(reader.getHeader()).rejects.toHaveProperty('name', 'AbortError')
  expect(state.reads).toBe(0)
})

test('close is safe when an underlying abort listener reenters it', async () => {
  const { filehandle, state } = controlledHandle()
  const reader = new FigWig({ filehandle })
  const paused = gate()
  state.nextRead = paused
  const outcome = reader.getHeader().then(
    () => ({ name: 'unexpected success' }),
    (error: Error) => error,
  )
  try {
    await paused.entered.promise
    const signal = state.signals.at(-1)
    expect(signal).toBeDefined()
    let reentered: Promise<void> | undefined
    signal!.addEventListener(
      'abort',
      () => {
        reentered = reader.close()
      },
      { once: true },
    )
    const closing = reader.close()
    expect(reentered).toBeDefined()
    await Promise.all([closing, reentered])
    expect(await promptly(outcome)).toHaveProperty('name', 'AbortError')
    expect(state.closes).toBe(1)
    paused.release.resolve()
    await paused.finished.promise
    await setImmediate()
    expect(state.reads).toBe(1)
    expect(state.stats).toBe(0)
    expect(reader.getDiagnostics().cacheBytes).toBe(0)
  } finally {
    paused.release.resolve()
    await outcome
    await reader.close()
  }
})

test('a warm single-region query rejects when close runs between its inner and outer continuations', async () => {
  class ClosingReader extends FigWig {
    closeOnResult = false
    override getValuesMulti(...args: Parameters<FigWig['getValuesMulti']>) {
      const pending = super.getValuesMulti(...args)
      if (this.closeOnResult) {
        // This observer is registered before getValues() awaits the returned
        // promise. Close therefore lands after the inner method succeeds but
        // before the single-region wrapper resumes with that cached result.
        void pending.then(
          () => {
            void this.close()
          },
          () => {},
        )
      }
      return pending
    }
  }
  const { filehandle, state } = controlledHandle()
  const reader = new ClosingReader({ filehandle })
  await reader.getValues('chr1', 0, 100, { tracks: ['signal'] })
  const reads = state.reads
  reader.closeOnResult = true
  const outcome = reader.getValues('chr1', 0, 100, { tracks: ['signal'] }).then(
    () => ({ name: 'unexpected success' }),
    (error: Error) => error,
  )
  expect(await outcome).toHaveProperty('name', 'AbortError')
  await reader.close()
  expect(state.closes).toBe(1)
  expect(state.reads).toBe(reads)
  expect(reader.getDiagnostics().cacheBytes).toBe(0)
})

test.each(['close', 'abort'] as const)(
  'required summaries preserve %s cancellation when availability is checked',
  async (mode) => {
    const controller = new AbortController()
    class CancellingReader extends FigWig {
      override async getSummary(...args: Parameters<FigWig['getSummary']>) {
        const cancel = () =>
          mode === 'close' ? this.close() : controller.abort()
        return {
          ...(await super.getSummary(...args)),
          get available() {
            // Cancel after summaries load, just before reporting unavailable.
            void cancel()
            return false
          },
        }
      }
    }
    const { filehandle } = controlledHandle()
    const reader = new CancellingReader({ filehandle })
    try {
      await expect(
        reader.getBins('chr1', 0, 64, {
          tracks: ['wide'],
          binSize: 64,
          missing: 'zero',
          requireSummaries: true,
          signal: controller.signal,
        }),
      ).rejects.toHaveProperty('name', 'AbortError')
      expect(reader.getDiagnostics()).toMatchObject({
        dataBytes: 0,
        chunksFetched: 0,
      })
    } finally {
      await reader.close()
    }
  },
)

test.each([false, true])(
  'coalesced group reads preserve another caller and abort only when all cancel (all: %s)',
  async (all) => {
    const { filehandle, state } = controlledHandle(),
      reader = new FigWig({ filehandle })
    await reader.getHeader()
    const before = state.reads,
      paused = gate(),
      first = new AbortController(),
      second = new AbortController()
    state.nextRead = paused
    const a = reader
      .getZoomLevels({ tracks: ['ones'], signal: first.signal })
      .then(
        () => ({ name: 'unexpected success' }),
        (error: Error) => error,
      )
    const b = reader
      .getZoomLevels({ tracks: ['random'], signal: second.signal })
      .then(
        (levels) => levels,
        (error: Error) => error,
      )
    try {
      await paused.entered.promise
      expect(state.reads - before).toBe(1)
      first.abort()
      expect(await promptly(a)).toHaveProperty('name', 'AbortError')
      expect(state.signals.at(-1)?.aborted).toBe(false)
      if (all) {
        second.abort()
        expect(await promptly(b)).toHaveProperty('name', 'AbortError')
        expect(state.signals.at(-1)?.aborted).toBe(true)
      }
      paused.release.resolve()
      await paused.finished.promise
      const surviving = await b
      if (!all) {
        expect(Array.isArray(surviving)).toBe(true)
        if (Array.isArray(surviving)) {
          expect(surviving.length).toBeGreaterThan(0)
          expect(
            surviving.every(
              (level) => level.groups.length === 1 && level.groups[0] === 1,
            ),
          ).toBe(true)
        }
      }
      await setImmediate()
      expect(state.reads - before).toBe(1)
      if (all) expect(reader.getDiagnostics().cacheBytes).toBe(0)
    } finally {
      paused.release.resolve()
      await Promise.all([a, b])
      await reader.close()
    }
  },
)
