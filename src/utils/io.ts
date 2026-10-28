import type { GenericFilehandle } from 'generic-filehandle2'
import { aborted, check } from './binary.js'

/** One semaphore per reader bounds metadata, index, and chunk reads together. */
export class ReadQueue {
  private active = 0
  private waiting: {
    signal?: AbortSignal
    start: () => void
    reject: (e: unknown) => void
    onAbort: () => void
  }[] = []
  constructor(private concurrency: number) {}
  async run<T>(
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    aborted(signal)
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        start: () => {
          this.active++
          signal?.removeEventListener('abort', waiter.onAbort)
          resolve()
        },
        reject,
        onAbort: () => {
          this.waiting = this.waiting.filter((w) => w !== waiter)
          reject(signal!.reason)
        },
      }
      if (this.active < this.concurrency) waiter.start()
      else {
        this.waiting.push(waiter)
        signal?.addEventListener('abort', waiter.onAbort, { once: true })
      }
    })
    try {
      aborted(signal)
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.start()
    }
  }
}
interface ReadRange {
  offset: number
  size: number
}
interface Job {
  ref: ReadRange
  signal: AbortSignal
  resolve: (value: Uint8Array) => void
  reject: (e: unknown) => void
}

/** Collect fills in a microtask so a whole batched query can coalesce ranges.
 * Each fill has the cache's shared signal. A range aborts only if all fills do. */
export class RangeReads {
  private jobs: Job[] = []
  private scheduled = false
  constructor(
    private read: (
      offset: number,
      size: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array>,
    private gap: number,
    private maxSize: number,
  ) {}
  get(ref: ReadRange, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.jobs.push({ ref, signal, resolve, reject })
      if (!this.scheduled) {
        this.scheduled = true
        queueMicrotask(() => this.flush())
      }
    })
  }
  private flush() {
    const jobs = this.jobs
    this.jobs = []
    this.scheduled = false
    const live: Job[] = []
    for (const job of jobs) {
      if (job.signal.aborted) job.reject(job.signal.reason)
      else live.push(job)
    }
    live.sort((a, b) => a.ref.offset - b.ref.offset)
    let batch: Job[] = [],
      first = 0,
      end = 0
    for (const job of live) {
      const nextEnd = job.ref.offset + job.ref.size
      if (
        batch.length &&
        (job.ref.offset > end + this.gap ||
          Math.max(nextEnd, end) - first > this.maxSize)
      ) {
        void this.fill(batch, first, end)
        batch = []
      }
      if (!batch.length) first = job.ref.offset
      end = Math.max(batch.length ? end : 0, nextEnd)
      batch.push(job)
    }
    if (batch.length) void this.fill(batch, first, end)
  }
  private async fill(jobs: Job[], first: number, end: number) {
    const controller = new AbortController()
    const abort = () => {
      if (jobs.every((j) => j.signal.aborted))
        controller.abort(jobs.find((j) => j.signal.aborted)?.signal.reason)
    }
    for (const job of jobs)
      job.signal.addEventListener('abort', abort, { once: true })
    abort()
    try {
      const data = await this.read(first, end - first, controller.signal)
      for (const job of jobs) {
        if (job.signal.aborted) job.reject(job.signal.reason)
        else
          job.resolve(
            data.subarray(
              job.ref.offset - first,
              job.ref.offset - first + job.ref.size,
            ),
          )
      }
    } catch (e) {
      for (const job of jobs) job.reject(e)
    } finally {
      for (const job of jobs) job.signal.removeEventListener('abort', abort)
    }
  }
}
export async function readExact(
  handle: GenericFilehandle,
  queue: ReadQueue,
  offset: number,
  size: number,
  maxRead: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  check(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      size <= maxRead &&
      Number.isSafeInteger(offset + size),
    'read exceeds bounds or maxReadBytes',
  )
  return queue.run(signal, async () => {
    const data = await handle.read(size, offset, { signal })
    aborted(signal)
    check(
      data.length === size,
      `truncated file: expected ${size} bytes at ${offset}, received ${data.length}`,
    )
    return data
  })
}
