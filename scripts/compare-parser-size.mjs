import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { gzipSync } from 'node:zlib'
import process from 'node:process'
import console from 'node:console'
import { build, version as esbuildVersion } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const baseline =
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ||
  '64f6e2c3bb9f27997d61c0ca7e6fef92a45def5f'
const baselineCommit = execFileSync(
  'git',
  ['rev-parse', '--verify', '--end-of-options', `${baseline}^{commit}`],
  { cwd: root, encoding: 'utf8' },
).trim()
const temporary = await mkdtemp(join(tmpdir(), 'figwig-parser-size-'))
try {
  // Read the baseline directly from Git without disturbing this checkout or its
  // uncommitted files. Both builds resolve the same locked dependencies.
  const paths = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', baselineCommit, '--', 'src'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
  for (const path of paths) {
    const destination = join(temporary, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(
      destination,
      execFileSync('git', ['show', `${baselineCommit}:${path}`], { cwd: root }),
    )
  }
  await writeFile(
    join(temporary, 'package.json'),
    '{"type":"module","sideEffects":false}\n',
  )
  await symlink(
    join(root, 'node_modules'),
    join(temporary, 'node_modules'),
    'dir',
  )
  async function measure(entryPoint) {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'browser',
      target: 'es2022',
      format: 'esm',
      minify: true,
      treeShaking: true,
      legalComments: 'none',
      write: false,
      metafile: true,
    })
    const contents = result.outputFiles[0].contents
    return {
      minifiedBytes: contents.length,
      gzip9Bytes: gzipSync(contents, { level: 9 }).length,
    }
  }
  const handwritten = await measure(join(temporary, 'src/index.ts'))
  const kaitai = await measure(join(root, 'src/index.ts'))
  const runtime = await measure(join(root, 'src/kaitai/generated/runtime.ts'))
  const report = {
    baselineCommit,
    kaitaiCompiler: '0.11.0',
    kaitaiRuntime: '0.11.0',
    esbuildVersion,
    configuration:
      'All public exports; browser ESM; ES2022; minify; gzip level 9; legal notices shipped separately',
    handwritten,
    kaitai,
    difference: {
      minifiedBytes: kaitai.minifiedBytes - handwritten.minifiedBytes,
      gzip9Bytes: kaitai.gzip9Bytes - handwritten.gzip9Bytes,
      minifiedPercent: Number(
        ((kaitai.minifiedBytes / handwritten.minifiedBytes - 1) * 100).toFixed(
          2,
        ),
      ),
      gzip9Percent: Number(
        ((kaitai.gzip9Bytes / handwritten.gzip9Bytes - 1) * 100).toFixed(2),
      ),
    },
    portableRuntimeAlone: runtime,
    scope:
      'Static code-size measurements only; no latency, throughput, allocation, or memory benchmarks',
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.argv.includes('--write')) {
    await mkdir(join(root, 'benchmarks/measurements'), { recursive: true })
    await writeFile(
      join(root, 'benchmarks/measurements/kaitai-size.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
