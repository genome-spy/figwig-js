# format_fixtures.py
# Contact: Jacob Schreiber <jmschreiber91@gmail.com>

"""The files tests/test_format.py and tests/test_kaitai.py read: small
figwig files written by `FigWigWriter` so that every chunk kind, every
element type, both orders, both codecs, zoom levels, chromosome edges,
several runs per group, an append and a merge are among them."""

import numpy

from figwig import FigWigWriter


CHROMS = {'chr1': 300, 'chr2': 100, 'chr3': 64}
TILE = 64
N_CELLS = 600


def values_of(length, rng):
	"""Values of the named tracks and the cells over `length` bases, built
	so that the chunks take every kind and element type."""

	v = numpy.zeros((len(NAMED), length))
	v[0, ::9] = 1                                   # sparse, "one"
	v[1, :] = rng.integers(0, 256, length)          # dense uint8, random: stored
	v[2, :] = rng.integers(0, 256, length)          # a second dense track
	v[3, 20:200] = 2.5                              # runs, float32
	v[4, 30:40] = 1.5                               # a second runs track
	v[5, ::5] = -rng.integers(1, 100, (length + 4) // 5)    # int8
	v[6, ::6] = -rng.integers(200, 30000, (length + 5) // 6)   # int16
	v[7, ::7] = -rng.integers(40000, 2 ** 31 - 1, (length + 6) // 7)  # int32
	v[8, ::4] = rng.integers(256, 65536, (length + 3) // 4)   # uint16
	v[9, ::8] = rng.integers(65536, 2 ** 32, (length + 7) // 8)   # uint32
	v[10, 10] = 2 ** 24 + 1                         # float64 track: wide
	v[10, 11] = 0.5
	v[11, ::3] = rng.normal(size=(length + 2) // 3).astype(numpy.float32)
	v[11, 7] = numpy.nan                            # float32 with NaN
	v[12, :] = rng.integers(256, 65536, length)     # dense uint16
	v[13, 5:60] = 3                                 # runs, uint8
	# track 14, 'empty', stays empty
	# Two groups of many cells of which few have a value in a tile, which
	# a matrix chunk holds; in a compressed file sparse chunks win unless
	# the group is large, so the cells are many and few are present.
	for c in range(0, N_CELLS, 150):                # matrix, uint8
		v[15 + c, (c * 11) % length] = c // 150 + 1
	for c in range(0, N_CELLS, 150):                # matrix with the one code
		v[15 + N_CELLS + c, (c * 7) % length] = 1
	return v


NAMED = ['ones', 'random', 'random2', 'runs', 'runs2', 'neg8', 'neg16',
	'neg32', 'u16', 'u32', {'name': 'wide', 'dtype': 'float64'}, {'name':
	'signal', 'dtype': 'float32', 'assay': 'ATAC'}, 'dense16', 'runs_int',
	'empty'] + [{'name': 'cell{}'.format(c), 'cell': c} for c in range(
	N_CELLS)] + [{'name': 'site{}'.format(c)} for c in range(N_CELLS)]
TRACKS = NAMED
GROUPS = [['ones'], ['random', 'random2'], ['runs', 'runs2'], ['neg8'],
	['neg16'], ['neg32'], ['u16'], ['u32'], ['wide', 'signal'], ['dense16'],
	['runs_int'], ['empty'], ['cell{}'.format(c) for c in range(N_CELLS)],
	['site{}'.format(c) for c in range(N_CELLS)]]


def write(path, level=6, zooms=2, order='positions', interleave=True):
	rng = numpy.random.default_rng(0)
	with FigWigWriter(path, CHROMS, TRACKS, genome='toy', attributes={'made':
			'test_format', 'n': [1, 2]}, tile=TILE, groups=GROUPS, level=level,
			zooms=zooms, order=order, n_jobs=2) as writer:
		for chrom, length in CHROMS.items():
			values = values_of(length, rng)
			if interleave and order == 'positions':
				# Each group in turn, two calls each, so that a group's chunks
				# lie in several runs.
				half = length // 2 // TILE * TILE or length
				for group in GROUPS:
					ids = [writer._track_ids[name] for name in group]
					writer.write(chrom, [0], values[None, ids, :half], tracks=group)
					if half < length:
						writer.write(chrom, [half], values[None, ids, half:],
							tracks=group)
			else:
				writer.write(chrom, [0], values[None])
	return path


def write_all(root):
	"""Write every fixture file under `root` and return them by name."""

	paths = {
		'zlib': write(root / 'zlib.fw'),
		'stored': write(root / 'stored.fw', level=0, zooms=0, interleave=False),
		'tracks': write(root / 'tracks.fw', order='tracks', level=0, zooms=1),
		'tracks_zlib': write(root / 'tracks_zlib.fw', order='tracks', level=6),
	}
	# An append leaves the old tables and index as dead bytes between the
	# chunks, and a merge copies another file's chunks.
	appended = root / 'appended.fw'
	appended.write_bytes((root / 'zlib.fw').read_bytes())
	with FigWigWriter(appended, None, ['late'], append=True) as writer:
		v = numpy.zeros((1, 1, CHROMS['chr1']))
		v[0, 0, 65] = 9
		writer.write('chr1', [0], v)
	paths['appended'] = appended
	with FigWigWriter(root / 'merged.fw', CHROMS, [], tile=TILE, level=6,
			zooms=2) as writer:
		writer.add_file(appended)
	paths['merged'] = root / 'merged.fw'

	# Track order with a chromosome long enough for several blocks.
	long_chroms = {'chrA': 200_000, 'chrB': 10}
	with FigWigWriter(root / 'blocks.fw', long_chroms, ['t', 'u', 'ones'],
			order='tracks', level=6, zooms=2) as writer:
		rng = numpy.random.default_rng(1)
		v = numpy.zeros((1, 3, 200_000))
		v[0, 0, rng.choice(200_000, 70_000, replace=False)] = rng.integers(1,
			1000, 70_000)
		v[0, 1, :5] = [1, numpy.nan, 3, 0, 5]
		v[0, 2, ::3] = 1                                 # a block of the one code
		writer.write('chrA', [0], v)
	paths['blocks'] = root / 'blocks.fw'
	return paths


