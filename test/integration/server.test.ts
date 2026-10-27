import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRangeServer } from '../../benchmarks/server/range-server.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())) })

async function fixture(options: Partial<Parameters<typeof startRangeServer>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'figwig-http-'))
  const bytes = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251)
  await writeFile(join(root, 'bytes.fw'), bytes)
  const server = await startRangeServer({ root, ...options })
  cleanup.push(async () => { await server.close(); await rm(root, { recursive: true, force: true }) })
  return { ...server, serverInstance: server, bytes }
}

describe('HTTP byte-range server', () => {
  test('returns only the requested body with correct range and CORS headers', async () => {
    const { url, bytes, serverInstance } = await fixture()
    const response = await fetch(`${url}/bytes.fw`, { headers: { Range: 'bytes=17-47' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 17-47/${bytes.length}`)
    expect(response.headers.get('content-length')).toBe('31')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toContain('Content-Range')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(17, 48))
    expect(serverInstance.metrics.bodyBytes).toBe(31)
    expect(serverInstance.metrics.requests).toBe(1)
  })

  test('supports suffix and open ranges and rejects unsatisfiable ranges', async () => {
    const { url, bytes } = await fixture()
    const suffix = await fetch(`${url}/bytes.fw`, { headers: { Range: 'bytes=-4' } })
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-4))
    const open = await fetch(`${url}/bytes.fw`, { headers: { Range: `bytes=${bytes.length - 3}-` } })
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(bytes.slice(-3))
    for (const range of ['bytes=999999-', 'bytes=10-9', 'bytes=0-1,5-6', 'bytes=abc']) {
      const response = await fetch(`${url}/bytes.fw`, { headers: { Range: range } })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
      expect((await response.arrayBuffer()).byteLength).toBe(0)
    }
  })

  test('supports HEAD and preflight, and enforces the request concurrency limit', async () => {
    const { url, bytes, serverInstance } = await fixture({ latencyMs: 15, maxConcurrent: 1 })
    const head = await fetch(`${url}/bytes.fw`, { method: 'HEAD', headers: { Range: 'bytes=1-3' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-length')).toBe('3')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    const preflight = await fetch(`${url}/bytes.fw`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Range')
    await Promise.all([1, 2, 3].map(async () => {
      const response = await fetch(`${url}/bytes.fw`, { headers: { Range: 'bytes=0-9' } })
      expect(response.headers.get('content-range')).toBe(`bytes 0-9/${bytes.length}`)
      await response.arrayBuffer()
    }))
    expect(serverInstance.metrics.peakConcurrent).toBe(1)
    expect(serverInstance.metrics.bodyBytes).toBe(30)
  })

  test('throttles bodies through a shared connection budget', async () => {
    const { url, serverInstance } = await fixture({ bandwidthBitsPerSecond: 8 * 100_000, chunkSize: 2000, maxConcurrent: 2 })
    const before = performance.now()
    const results = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${url}/bytes.fw`, { headers: { Range: 'bytes=0-9999' } })
      return response.arrayBuffer()
    }))
    expect(results.map(result => result.byteLength)).toEqual([10_000, 10_000])
    expect(performance.now() - before).toBeGreaterThanOrEqual(175)
    expect(serverInstance.metrics.peakConcurrent).toBe(2)
    expect(serverInstance.metrics.bodyBytes).toBe(20_000)
  })

  test('observes disconnects and stops transferring cancelled responses', async () => {
    const { url, bytes, serverInstance } = await fixture({ bandwidthBitsPerSecond: 8 * 50_000, chunkSize: 1000 })
    const controller = new AbortController()
    const response = await fetch(`${url}/bytes.fw`, { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await expect.poll(() => serverInstance.metrics.cancelled).toBe(1)
    expect(serverInstance.metrics.bodyBytes).toBeLessThan(bytes.length)
  })
})
