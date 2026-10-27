import { createServer, type ServerResponse } from 'node:http'
import { open, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

export interface NetworkOptions {
  root: string
  latencyMs?: number
  /** Shared budget for all response bodies, in bits per second. Zero is unlimited. */
  bandwidthBitsPerSecond?: number
  jitterMs?: number
  seed?: number
  maxConcurrent?: number
  chunkSize?: number
  port?: number
}

export interface RangeRecord {
  path: string
  range: string | undefined
  start: number
  end: number
  status: number
  bodyBytes: number
  cancelled: boolean
}

export interface ServerMetrics {
  requests: number
  bodyBytes: number
  active: number
  peakConcurrent: number
  cancelled: number
  ranges: RangeRecord[]
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError())
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolveDelay()
    }, milliseconds)
    function aborted() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

/** A deterministic localhost server; no transparent HTTP content compression. */
export async function startRangeServer(options: NetworkOptions) {
  const root = resolve(options.root)
  const concurrency = options.maxConcurrent ?? 8
  const chunkSize = options.chunkSize ?? 16 * 1024
  const latency = options.latencyMs ?? 0
  const bandwidth = options.bandwidthBitsPerSecond ?? 0
  const jitter = options.jitterMs ?? 0
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    ![latency, bandwidth, jitter].every(Number.isFinite) ||
    latency < 0 ||
    bandwidth < 0 ||
    jitter < 0
  ) {
    throw new Error('Invalid network simulation options')
  }
  let metrics: ServerMetrics = {
    requests: 0,
    bodyBytes: 0,
    active: 0,
    peakConcurrent: 0,
    cancelled: 0,
    ranges: [],
  }
  let sequence = 0
  let busy = 0
  let bandwidthAvailableAt = 0
  const waiting: (() => void)[] = []
  const controllers = new Set<AbortController>()
  const tasks = new Set<Promise<void>>()

  async function slot(signal: AbortSignal) {
    while (busy >= concurrency) {
      await new Promise<void>((resolveSlot, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', abort)
          resolveSlot()
        }
        const abort = () => {
          const index = waiting.indexOf(wake)
          if (index >= 0) waiting.splice(index, 1)
          reject(abortError())
        }
        waiting.push(wake)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    signal.throwIfAborted()
    busy++
  }

  async function send(
    response: ServerResponse,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    if (bandwidth > 0) {
      // Reserving from a single timeline prevents parallel requests from multiplying
      // the link's bandwidth. Each reservation is one small body chunk, not a
      // single delay followed by an unthrottled whole-file response.
      const now = performance.now()
      bandwidthAvailableAt =
        Math.max(now, bandwidthAvailableAt) +
        (bytes.byteLength * 8000) / bandwidth
      await delay(bandwidthAvailableAt - now, signal)
    }
    signal.throwIfAborted()
    await new Promise<void>((resolveWrite, reject) => {
      response.write(bytes, (error?: Error | null) => {
        if (error) reject(error)
        else resolveWrite()
      })
    })
  }

  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    response.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges',
    )
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end()
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    controllers.add(controller)
    const currentMetrics = metrics
    const ordinal = sequence++
    const record: RangeRecord = {
      path: request.url ?? '/',
      range: request.headers.range,
      start: 0,
      end: -1,
      status: 0,
      bodyBytes: 0,
      cancelled: false,
    }
    currentMetrics.requests++
    currentMetrics.ranges.push(record)
    response.on('close', () => {
      if (!response.writableFinished) {
        controller.abort()
        record.cancelled = true
        currentMetrics.cancelled++
      }
    })
    const task = (async () => {
      let acquired = false
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const path = resolve(
          root,
          `.${decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)}`,
        )
        if (path !== root && !path.startsWith(root + sep)) {
          record.status = 403
          response.writeHead(403).end()
          return
        }
        const info = await stat(path)
        if (!info.isFile())
          throw Object.assign(new Error('Not a file'), { code: 'ENOENT' })
        const size = info.size
        let start = 0
        let end = size - 1
        if (request.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
          if (match && (match[1] || match[2])) {
            if (match[1]) {
              start = Number(match[1])
              end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
            } else {
              start = Math.max(0, size - Number(match[2]))
            }
          } else start = size
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= size
          ) {
            record.status = 416
            response
              .writeHead(416, {
                'Content-Range': `bytes */${size}`,
                'Content-Length': 0,
              })
              .end()
            return
          }
        }
        record.start = start
        record.end = end
        record.status = request.headers.range ? 206 : 200
        await slot(signal)
        acquired = true
        currentMetrics.active++
        currentMetrics.peakConcurrent = Math.max(
          currentMetrics.peakConcurrent,
          currentMetrics.active,
        )
        // Integer hash: jitter depends only on request ordinal and seed.
        const mixed =
          Math.imul(
            (ordinal + (options.seed ?? 1)) ^ 0x9e3779b9,
            0x85ebca6b,
          ) >>> 0
        await delay(
          latency + (jitter ? (mixed / 0xffffffff) * jitter : 0),
          signal,
        )
        response.statusCode = record.status
        response.setHeader('Content-Length', Math.max(0, end - start + 1))
        if (request.headers.range)
          response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        if (request.method === 'HEAD' || size === 0) {
          response.end()
          return
        }
        handle = await open(path, 'r')
        let position = start
        while (position <= end) {
          signal.throwIfAborted()
          const buffer = new Uint8Array(Math.min(chunkSize, end - position + 1))
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            position,
          )
          if (!bytesRead)
            throw new Error('File changed or was truncated during transfer')
          await send(response, buffer.subarray(0, bytesRead), signal)
          record.bodyBytes += bytesRead
          currentMetrics.bodyBytes += bytesRead
          position += bytesRead
        }
        response.end()
      } catch (error) {
        if (!signal.aborted) {
          record.status =
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500
          if (!response.headersSent) response.writeHead(record.status).end()
          else response.destroy(error instanceof Error ? error : undefined)
        }
      } finally {
        await handle?.close()
        controllers.delete(controller)
        if (acquired) {
          busy--
          currentMetrics.active--
          waiting.shift()?.()
        }
      }
    })()
    tasks.add(task)
    void task.finally(() => tasks.delete(task))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to listen')
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    get metrics() {
      return structuredClone(metrics)
    },
    resetMetrics() {
      if (busy) throw new Error('Cannot reset metrics with active transfers')
      metrics = {
        requests: 0,
        bodyBytes: 0,
        active: 0,
        peakConcurrent: 0,
        cancelled: 0,
        ranges: [],
      }
      sequence = 0
      bandwidthAvailableAt = 0
    },
    async close() {
      for (const controller of controllers) controller.abort()
      const closing = new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      )
      server.closeAllConnections()
      await Promise.allSettled([...tasks])
      await closing
    },
  }
}
