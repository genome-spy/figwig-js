import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlobFile, LocalFile } from 'generic-filehandle2';
import { describe, expect, test } from 'vitest';
import { FigWig } from '../../src/index.js';
import { decodeNumber, expectedValues, fixturePath, oracle } from './oracle.js';

function exact(actual: ArrayLike<number>, expected: ArrayLike<number>, context: string) {
  expect(actual.length, `${context}: array length`).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (!Object.is(actual[i], expected[i])) {
      expect(actual[i], `${context}: base ${i}`).toBe(expected[i]);
    }
  }
}

describe('independent upstream conformance oracle', () => {
  test('includes every chunk kind, numeric element code and storage flag', () => {
    expect(oracle.provenance.commit).toBe('c0e5d6522c677b9f03cd6831e2dbcea759866628');
    expect(oracle.coverage).toEqual({ chunkKinds: [1, 2, 3, 4], elementCodes: [0, 1, 2, 3, 4, 5, 6, 7, 8], storedFlags: [false, true] });
  });

  for (const [name, file] of Object.entries(oracle.files)) {
    describe(name, () => {
      test('fixture checksum matches the pinned oracle', () => {
        const bytes = readFileSync(fixturePath(name));
        expect(bytes.length).toBe(file.size);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      });

      test('reads every base of every track exactly', async () => {
        const reader = new FigWig({ filehandle: new LocalFile(fixturePath(name)) });
        const header = await reader.getHeader();
        expect(header.order).toBe(file.order);
        expect(header.tileSize).toBe(file.tile);
        expect(header.genome).toBe(file.metadata.genome ?? null);
        expect(header.attributes).toEqual(file.metadata.attributes);
        expect(header.statistics).toEqual(file.stats.map(stat => Object.fromEntries(Object.entries(stat).map(([key, value]) => [key, decodeNumber(value)]))));
        const tracks = await reader.getTracks();
        expect(tracks.map(track => ({ name: track.name, dtype: track.dtype, group: track.group }))).toEqual(
          file.metadata.tracks.map(track => ({ name: track.name, dtype: track.dtype, group: track.group })),
        );
        for (const [chromosome, chrom] of Object.entries(oracle.datasets[file.dataset]!.chromosomes)) {
          const result = await reader.getValues(chromosome, 0, chrom.length);
          expect(result.tracks.map(item => item.track.name)).toEqual(tracks.map(track => track.name));
          for (const item of result.tracks) {
            expect(ArrayBuffer.isView(item.values)).toBe(true);
            exact(item.values, expectedValues(file.dataset, chromosome, item.track.name, 0, chrom.length), `${name}/${chromosome}/${item.track.name}`);
          }
        }
      }, 30_000);

      test('deterministic random windows and reordered track selections agree exactly', async () => {
        const reader = new FigWig({ filehandle: new LocalFile(fixturePath(name)) });
        const queries = oracle.datasets[file.dataset]!.queries;
        for (const query of queries) {
          const result = await reader.getValues(query.chromosome, query.start, query.end, { tracks: query.tracks });
          expect(result.tracks.map(item => item.track.name)).toEqual(query.tracks);
          for (const item of result.tracks) {
            exact(item.values, expectedValues(file.dataset, query.chromosome, item.track.name, query.start, query.end), `${name}/${query.chromosome}/${item.track.name}:${query.start}-${query.end}`);
          }
        }
      }, 30_000);

      test('binned sums and means implement missing and partial-bin semantics', async () => {
        const reader = new FigWig({ filehandle: new LocalFile(fixturePath(name)) });
        const chromosome = name === 'blocks' ? 'chrA' : 'chr1';
        const tracks = name === 'blocks' ? ['t', 'u', 'ones'] : ['runs', 'signal', 'wide', 'u32', 'empty'];
        for (const aggregation of ['sum', 'mean'] as const) {
          for (const missing of ['propagate', 'omit', 'zero'] as const) {
            const result = await reader.getBins(chromosome, 5, 74, { tracks, binSize: 17, aggregation, missing });
            expect(Array.from(result.starts)).toEqual([5, 22, 39, 56, 73]);
            expect(Array.from(result.ends)).toEqual([22, 39, 56, 73, 74]);
            expect(result.source).toBe('values');
            for (const item of result.tracks) {
              const expected = Array.from(result.starts, (start, index) => {
                const values = expectedValues(file.dataset, chromosome, item.track.name, start, result.ends[index]!);
                let sum = 0;
                let count = 0;
                let hasNaN = false;
                for (const value of values) {
                  if (Number.isNaN(value)) {
                    hasNaN = true;
                    if (missing === 'zero') count++;
                  } else {
                    sum += value;
                    count++;
                  }
                }
                if (hasNaN && missing === 'propagate') return NaN;
                return aggregation === 'sum' ? sum : count ? sum / count : NaN;
              });
              exact(item.values, expected, `${name}/bins/${item.track.name}/${aggregation}/${missing}`);
            }
          }
        }
      });

      test('tile summaries and every zoom level match Python bit for bit', async () => {
        const reader = new FigWig({ filehandle: new LocalFile(fixturePath(name)) });
        for (let group = 0; group < file.groups.length; group++) {
          const expected = file.groups[group]!;
          if (expected.summary) {
            const summary = await reader.getSummary(group);
            expect(summary.available).toBe(true);
            expect(Array.from(summary.bins)).toEqual(expected.summary.ids);
            exact(summary.sums, expected.summary.sums.flat().map(decodeNumber), `${name}/summary/${group}`);
            expect(summary.binSize).toBe(file.tile);
          }
          for (let level = 1; level <= expected.zooms.length; level++) {
            const zoom = expected.zooms[level - 1]!;
            const summary = await reader.getSummary(group, level);
            expect(summary.factor).toBe(zoom.factor);
            expect(summary.binSize).toBe(file.tile * zoom.factor);
            expect(Array.from(summary.bins)).toEqual(zoom.ids);
            exact(summary.sums, zoom.sums.flat().map(decodeNumber), `${name}/zoom/${group}/${level}`);
          }
        }
        const expectedLevels = new Map<number, number[]>();
        for (let group = 0; group < file.groups.length; group++) {
          for (let index = 0; index < file.groups[group]!.zooms.length; index++) {
            const level = index + 1;
            const groups = expectedLevels.get(level) ?? [];
            groups.push(group);
            expectedLevels.set(level, groups);
          }
        }
        expect(await reader.getZoomLevels()).toEqual(Array.from(expectedLevels, ([level, groups]) => ({
          level, factor: 4 ** level, binSize: file.tile * 4 ** level, groups,
        })));
      }, 30_000);
    });
  }

  test('integer precision and NaNs survive heterogeneous chunks', async () => {
    const reader = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    const result = await reader.getValues('chr1', 0, 64, { tracks: ['wide', 'u32', 'signal', 'empty'] });
    expect(result.tracks[0]!.values[10]).toBe(2 ** 24 + 1);
    expect(result.tracks[0]!.values[11]).toBe(0.5);
    expect(result.tracks[1]!.values[0]).toBeGreaterThan(2 ** 24);
    expect(Number.isNaN(result.tracks[2]!.values[7])).toBe(true);
    expect(result.tracks[2]!.values[8]).toBe(0);
    expect(Array.from(result.tracks[3]!.values).every(value => value === 0)).toBe(true);
  });

  test('metadata filters preserve source order and integer selections preserve caller order', async () => {
    const reader = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    expect((await reader.selectTracks({ assay: 'ATAC' })).map(track => track.name)).toEqual(['signal']);
    const tracks = await reader.getTracks();
    const indices = [11, 0, 9];
    const result = await reader.getValues('chr1', 4, 75, { tracks: indices });
    expect(result.tracks.map(item => item.track.name)).toEqual(indices.map(index => tracks[index]!.name));
  });

  test('all-NaN bins distinguish omission, zero-filling and propagation', async () => {
    const reader = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    for (const missing of ['propagate', 'omit', 'zero'] as const) {
      const sum = await reader.getBins('chr1', 7, 8, { tracks: ['signal'], binSize: 1, aggregation: 'sum', missing });
      const mean = await reader.getBins('chr1', 7, 8, { tracks: ['signal'], binSize: 1, aggregation: 'mean', missing });
      expect(sum.tracks[0]!.values[0]).toBe(missing === 'propagate' ? NaN : 0);
      expect(mean.tracks[0]!.values[0]).toBe(missing === 'zero' ? 0 : NaN);
    }
  });

  test('rounded summaries require explicit opt-in and zero-filled missing data', async () => {
    const reader = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    const precise = await reader.getBins('chr1', 0, 64, { tracks: ['wide'], binSize: 64, aggregation: 'sum' });
    const rounded = await reader.getBins('chr1', 0, 64, { tracks: ['wide'], binSize: 64, aggregation: 'sum', missing: 'zero', useSummaries: true });
    expect(precise.source).toBe('values');
    expect(precise.tracks[0]!.values[0]).toBe(2 ** 24 + 1.5);
    expect(rounded.source).toBe('summary');
    expect(rounded.tracks[0]!.values[0]).toBe(Math.fround(2 ** 24 + 1.5));
    const omit = await reader.getBins('chr1', 0, 64, { tracks: ['signal'], binSize: 64, aggregation: 'mean', missing: 'omit', useSummaries: true });
    expect(omit.source).toBe('values');
  });

  test('features reuse typed queries and preserve track identity and partial spans', async () => {
    const reader = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    const regions = [{ chromosome: 'chr1', start: 5, end: 19 }, { chromosome: 'chr2', start: 60, end: 74 }];
    const options = { tracks: ['ones', 'wide'], basesPerSpan: 5, aggregation: 'sum' as const };
    const batches = await reader.getFeaturesMulti(regions, options);
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index]!;
      const independent = await reader.getFeatures(region.chromosome, region.start, region.end, options);
      expect(batches[index]).toEqual(independent);
      for (const track of options.tracks) {
        const rows = independent.filter(row => row.track === track);
        expect(rows.map(row => [row.start, row.end])).toEqual([[region.start, region.start + 5], [region.start + 5, region.start + 10], [region.start + 10, region.end]]);
        for (const row of rows) {
          const expected = expectedValues('toy', region.chromosome, track, row.start, row.end).reduce((sum, value) => sum + value, 0);
          expect(row.score).toBe(expected);
        }
      }
    }
  });

  test('BlobFile and LocalFile produce identical subset batches including empty intervals', async () => {
    const bytes = readFileSync(fixturePath('zlib'));
    const blob = new FigWig({ filehandle: new BlobFile(new Blob([new Uint8Array(bytes)])) });
    const local = new FigWig({ filehandle: new LocalFile(fixturePath('zlib')) });
    const regions = [
      { chromosome: 'chr2', start: 90, end: 100 },
      { chromosome: 'chr1', start: 60, end: 130 },
      { chromosome: 'chr1', start: 64, end: 64 },
      { chromosome: 'chr3', start: 0, end: 64 },
      { chromosome: 'chr1', start: 63, end: 80 },
    ];
    const options = { tracks: ['signal', 'wide', 'ones', 'cell150', 'site300'] };
    const actual = await blob.getValuesMulti(regions, options);
    const expected = await local.getValuesMulti(regions, options);
    expect(actual).toEqual(expected);
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      for (const item of actual[i]!.tracks) {
        exact(item.values, expectedValues('toy', region.chromosome, item.track.name, region.start, region.end), `BlobFile/batch/${i}/${item.track.name}`);
      }
    }
  });
});
