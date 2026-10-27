# format_reference.py
# Contact: Jacob Schreiber <jmschreiber91@gmail.com>

"""A reader of figwig files written from the format specification alone,
docs/format.rst, with numpy, zlib, json and struct, and nothing from the
figwig package.

It exists to prove the specification complete: `tests/test_format.py`
reads files the package writes through it and compares every value, every
table and every index record with what `FigWigReader` gives, and a layout
the specification does not describe would not decode here. It checks what
the specification says a reader must check, and raises `FormatError`, a
`ValueError`, for anything else. It is written for clarity, not speed; it
decodes a chunk into a float64 array of every track's values over the
tile, and a whole file into one array per chromosome.
"""

import json
import struct
import zlib

import numpy


MAGIC = 0x57474946             # b'FIGW' read as a little-endian uint32
VERSION = 1
HEADER_SIZE = 128
HEADER = struct.Struct('<IHHIHHIIIIQQQQQQQQIII20s')
HEADER_FIELDS = ('magic', 'version', 'flags', 'tile', 'codec', 'level',
	'n_chroms', 'n_tracks', 'n_groups', 'tables_crc', 'chroms', 'tracks',
	'index', 'data', 'metadata', 'metadata_length', 'zooms', 'length',
	'required', 'optional', 'header_crc', 'padding')
HEADER_CRC_AT = 104

FLAG_TRACKS = 1               # flags bit 0: track order
KNOWN_FLAGS = FLAG_TRACKS
KNOWN_REQUIRED = 0
OPTIONAL_ZOOMS = 1            # optional bit 0: a zoom section per record
CODEC_NONE, CODEC_ZLIB = 0, 1
MIN_TILE, MAX_TILE = 16, 65536
MAX_TILES = 1 << 26
MAX_CHROM_LENGTH = 2 ** 32 - 1
MAX_ZOOMS = 12
BLOCK_ENTRIES = 1 << 16

KIND_ZERO, KIND_DENSE, KIND_SPARSE, KIND_MATRIX, KIND_RUNS = 0, 1, 2, 3, 4
KIND_MASK, CODE_SHIFT, CODE_MASK, STORED = 7, 3, 15, 128
CODE_ONE, CODE_F64 = 7, 8
ELEMENT_DTYPES = ['<u1', '<u2', '<u4', '<i1', '<i2', '<i4', '<f4', None,
	'<f8']
ELEMENT_WIDTHS = [1, 2, 4, 1, 2, 4, 4, 0, 8]
DTYPES = ('uint8', 'uint16', 'uint32', 'int8', 'int16', 'int32', 'float32',
	'float64')

RUN = numpy.dtype([('first', '<u8'), ('last', '<u8'), ('offset', '<u8'),
	('bytes', '<u8')])
LIVE_FIELDS = (('tile', '<u4'), ('kind', 'u1'), ('size', '<u4'),
	('raw', '<u4'), ('crc', '<u4'))
BLOCK = numpy.dtype([('chrom', '<u4'), ('first', '<u4'), ('last', '<u4'),
	('n', '<u4'), ('offset', '<u8'), ('size', '<u4'), ('raw', '<u4'),
	('kind', '<u4'), ('crc', '<u4')])
STATS = numpy.dtype([('sum', '<f8'), ('nonzero', '<u8'), ('min', '<f8'),
	('max', '<f8')])


class FormatError(ValueError):
	"""The file does not follow the specification."""


def pad4(n):
	return (n + 3) // 4 * 4


def pad8(n):
	return (n + 7) // 8 * 8


def inflate(stream, n):
	"""The n bytes a zlib stream holds, exactly."""

	inflater = zlib.decompressobj()
	try:
		raw = inflater.decompress(stream, n + 1)
	except zlib.error as e:
		raise FormatError("a zlib stream is corrupt: {}".format(e)) from None
	if len(raw) != n or not inflater.eof or inflater.unused_data:
		raise FormatError("a zlib stream does not hold the bytes it should.")
	return raw


def varint(data, at, end):
	"""The LEB128 varint at `at`, which must end by `end`, and where it
	ends; the specification allows at most three bytes."""

	value, shift = 0, 0
	for k in range(3):
		if at >= end:
			raise FormatError("a varint runs past its track's bytes.")
		byte = data[at]
		at += 1
		value |= (byte & 127) << shift
		shift += 7
		if byte < 128:
			return value, at
	raise FormatError("a varint takes more than three bytes.")


class Header:
	def __init__(self, raw):
		if len(raw) < HEADER_SIZE:
			raise FormatError("the file is shorter than a header.")
		values = HEADER.unpack(raw[:HEADER_SIZE])
		for name, value in zip(HEADER_FIELDS, values):
			setattr(self, name, value)
		if self.magic != MAGIC:
			raise FormatError("the magic number is not FIGW.")
		expected = zlib.crc32(raw[:HEADER_CRC_AT] + bytes(4) + raw[HEADER_CRC_AT
			+ 4:HEADER_SIZE])
		if self.header_crc != expected:
			raise FormatError("the header does not match its CRC-32.")
		if self.version != VERSION:
			raise FormatError("the file is version {}, not {}.".format(
				self.version, VERSION))
		if self.required & ~KNOWN_REQUIRED:
			raise FormatError("the file requires a feature this reader does not "
				"know.")
		if self.flags & ~KNOWN_FLAGS:
			raise FormatError("the header's flags hold an unknown bit.")
		if not MIN_TILE <= self.tile <= MAX_TILE or self.tile & (self.tile - 1):
			raise FormatError("the tile is not a power of two from 16 to 65536.")
		if self.codec not in (CODEC_NONE, CODEC_ZLIB):
			raise FormatError("the codec is not 0 or 1.")
		if self.data != HEADER_SIZE:
			raise FormatError("the data offset is not 128.")
		if self.length < HEADER_SIZE:
			raise FormatError("the length is shorter than the header.")
		if not HEADER_SIZE <= self.chroms <= self.tracks <= self.metadata <= \
				self.index <= self.length:
			raise FormatError("the tables are out of order or outside the file.")
		if self.n_chroms == 0 or self.n_tracks == 0 or self.n_groups == 0:
			raise FormatError("the file has no chromosomes, tracks or groups.")
		self.order = 'tracks' if self.flags & FLAG_TRACKS else 'positions'
		if self.order == 'tracks' and self.n_groups != self.n_tracks:
			raise FormatError("a file in track order needs a group per track.")


class Group:
	"""One group's index record: in position order its runs and live tiles,
	in track order its blocks; either way its summary and zoom levels."""

	def __init__(self):
		self.runs = None
		self.live = None
		self.blocks = None
		self.summary = None
		self.zooms = []
		self.offsets = None


class File:
	"""A figwig file's header, tables, metadata and index, read and checked
	as the specification says."""

	def __init__(self, path):
		self.path = path
		with open(path, 'rb') as handle:
			self.bytes = handle.read()
		data = self.bytes
		self.header = header = Header(data)
		if header.length > len(data):
			raise FormatError("the file is shorter than its header's length.")

		tables_end = header.index + 8 * header.n_groups
		if tables_end > header.length:
			raise FormatError("the file ends inside the index's directory.")
		if zlib.crc32(data[header.chroms:tables_end]) != header.tables_crc:
			raise FormatError("the tables do not match their CRC-32.")

		self.chrom_sizes = self._chroms(data, header.chroms, header.tracks,
			header.n_chroms)
		stats_end = header.tracks + header.n_tracks * STATS.itemsize
		if stats_end > header.metadata:
			raise FormatError("the statistics table runs into the metadata.")
		self.stats = numpy.frombuffer(data, dtype=STATS, count=header.n_tracks,
			offset=header.tracks).copy()
		if header.metadata + header.metadata_length > header.index:
			raise FormatError("the metadata runs into the index.")
		self.metadata = self._metadata(data[header.metadata:header.metadata +
			header.metadata_length])
		self.tracks = self.metadata['tracks']
		self.directory = numpy.frombuffer(data, dtype='<u8',
			count=header.n_groups, offset=header.index).astype(numpy.int64)

		self.group_tracks = [[] for _ in range(header.n_groups)]
		for i, track in enumerate(self.tracks):
			self.group_tracks[track['group']].append(i)
		if any(len(members) == 0 for members in self.group_tracks):
			raise FormatError("a group has no tracks.")

		lengths = numpy.array(list(self.chrom_sizes.values()), dtype=numpy.int64)
		counts = (lengths + header.tile - 1) // header.tile
		self.tile_offsets = numpy.concatenate([[0], numpy.cumsum(counts)])
		self.n_tiles = int(self.tile_offsets[-1])
		if self.n_tiles > MAX_TILES:
			raise FormatError("the genome has more than 2**26 tiles.")
		self.groups = [self._record(g) for g in range(header.n_groups)]

	def _chroms(self, data, at, end, n):
		chroms = {}
		for _ in range(n):
			if at + 2 > end:
				raise FormatError("the file ends inside the chromosome table.")
			size = struct.unpack_from('<H', data, at)[0]
			if at + 2 + size + 8 > end:
				raise FormatError("the file ends inside the chromosome table.")
			name = data[at + 2:at + 2 + size].decode('utf-8')
			length = struct.unpack_from('<Q', data, at + 2 + size)[0]
			if not name or name in chroms or not 1 <= length <= MAX_CHROM_LENGTH:
				raise FormatError("a chromosome's name or length is invalid.")
			chroms[name] = int(length)
			at += 2 + size + 8
		return chroms

	def _metadata(self, raw):
		try:
			metadata = json.loads(raw.decode('utf-8'))
		except (UnicodeDecodeError, ValueError):
			raise FormatError("the metadata is not a JSON document.") from None
		if not isinstance(metadata, dict):
			raise FormatError("the metadata is not a JSON object.")
		if not isinstance(metadata.get('attributes', {}), dict) or \
				metadata.get('attributes') is None:
			raise FormatError("the metadata's attributes are not an object.")
		tracks = metadata.get('tracks')
		if not isinstance(tracks, list) or len(tracks) != self.header.n_tracks:
			raise FormatError("the metadata does not list every track.")
		names = set()
		for track in tracks:
			if not isinstance(track, dict) or not isinstance(track.get('name'),
					str) or track.get('dtype') not in DTYPES or not isinstance(
					track.get('group'), int) or isinstance(track['group'], bool) \
					or not 0 <= track['group'] < self.header.n_groups:
				raise FormatError("a track record lacks its name, dtype or group.")
			if track['name'] in names:
				raise FormatError("two tracks share a name.")
			names.add(track['name'])
		return metadata

	def _record(self, g):
		data, header = self.bytes, self.header
		at = int(self.directory[g])
		if not HEADER_SIZE <= at < header.length:
			raise FormatError("a group's record lies outside the file.")
		group = Group()
		n_tracks = len(self.group_tracks[g])
		n, crc = struct.unpack_from('<II', data, at)
		at += 8
		if header.order == 'tracks':
			end = at + n * BLOCK.itemsize
			if end > header.length:
				raise FormatError("the file ends inside a track's blocks.")
			if zlib.crc32(data[at:end]) != crc:
				raise FormatError("a track's blocks do not match their CRC-32.")
			group.blocks = numpy.frombuffer(data, dtype=BLOCK, count=n,
				offset=at).copy()
			self._check_blocks(group.blocks)
			at = end
		else:
			runs_end = at + n * RUN.itemsize
			if runs_end + 8 > header.length:
				raise FormatError("the file ends inside a group's runs.")
			group.runs = numpy.frombuffer(data, dtype=RUN, count=n, offset=at
				).copy()
			n_live, n_bytes = struct.unpack_from('<II', data, runs_end)
			stream_at = runs_end + 8
			if stream_at + n_bytes > header.length:
				raise FormatError("the file ends inside a group's live tiles.")
			if zlib.crc32(data[at:stream_at + n_bytes]) != crc:
				raise FormatError("a group's record does not match its CRC-32.")
			if n_live > self.n_tiles:
				raise FormatError("a group lists more live tiles than the genome "
					"has.")
			raw = inflate(data[stream_at:stream_at + n_bytes], 17 * n_live)
			live, position = {}, 0
			for name, dtype in LIVE_FIELDS:
				width = numpy.dtype(dtype).itemsize
				live[name] = numpy.frombuffer(raw, dtype=dtype, count=n_live,
					offset=position).astype(numpy.int64)
				position += width * n_live
			group.live = live
			self._check_live(group, n_tracks)
			at = stream_at + n_bytes

		n_sum, n_bytes, crc = struct.unpack_from('<III', data, at)
		at += 12
		if at + n_bytes > header.length:
			raise FormatError("the file ends inside a group's summary.")
		if n_sum > self.n_tiles:
			raise FormatError("a summary lists more tiles than the genome has.")
		if zlib.crc32(data[at:at + n_bytes]) != crc:
			raise FormatError("a summary does not match its CRC-32.")
		if n_bytes > 0:
			raw = inflate(data[at:at + n_bytes], n_sum * (4 + 4 * n_tracks))
			tiles = numpy.frombuffer(raw, dtype='<u4', count=n_sum).astype(
				numpy.int64)
			if n_sum and (tiles[-1] >= self.n_tiles or (numpy.diff(tiles) <= 0
					).any()):
				raise FormatError("a summary's tiles are out of order.")
			sums = numpy.frombuffer(raw, dtype='<f4', offset=4 * n_sum).reshape(
				n_sum, n_tracks)
			group.summary = (tiles, sums)
		at += n_bytes

		if header.optional & OPTIONAL_ZOOMS:
			n_zooms = struct.unpack_from('<I', data, at)[0]
			at += 4
			if n_zooms > MAX_ZOOMS:
				raise FormatError("a record names more than 12 zoom levels.")
			for k in range(n_zooms):
				factor, n, n_bytes, crc = struct.unpack_from('<IIII', data, at)
				at += 16
				if factor != 4 ** (k + 1):
					raise FormatError("a zoom level's factor is not 4**k.")
				bins_per_chrom = -(-((numpy.diff(self.tile_offsets))) // factor)
				n_bins = int(bins_per_chrom.sum())
				if n > n_bins or at + n_bytes > header.length:
					raise FormatError("a zoom level lies outside the file.")
				stream = data[at:at + n_bytes]
				if zlib.crc32(stream) != crc:
					raise FormatError("a zoom level does not match its CRC-32.")
				raw = inflate(stream, n * (4 + 8 * n_tracks))
				bins = numpy.frombuffer(raw, dtype='<u4', count=n).astype(
					numpy.int64)
				if n and (bins[-1] >= n_bins or (numpy.diff(bins) <= 0).any()):
					raise FormatError("a zoom level's bins are out of order.")
				sums = numpy.frombuffer(raw, dtype='<f8', offset=4 * n).reshape(n,
					n_tracks)
				group.zooms.append((factor, bins, sums))
				at += n_bytes
		return group

	def _check_live(self, group, n_tracks):
		"""The live tiles ascend, every live chunk has a kind and bytes,
		and the runs cover exactly the live tiles, back to back."""

		header = self.header
		live, runs = group.live, group.runs
		tiles, kinds, sizes, raws = live['tile'], live['kind'], live['size'], \
			live['raw']
		if len(tiles) and (tiles[-1] >= self.n_tiles or (numpy.diff(tiles) <= 0
				).any()):
			raise FormatError("a group's live tiles are out of order.")
		if ((kinds & KIND_MASK) == KIND_ZERO).any() or ((kinds & KIND_MASK) >
				KIND_RUNS).any() or (((kinds >> CODE_SHIFT) & CODE_MASK) > CODE_F64
				).any():
			raise FormatError("a live tile's kind byte is not one the format "
				"defines.")
		if (sizes == 0).any() or (raws == 0).any():
			raise FormatError("a live tile has no bytes.")
		stored = (kinds & STORED) > 0
		if (stored & (sizes != raws)).any() or (header.codec == CODEC_NONE and (
				sizes != raws).any()):
			raise FormatError("a chunk's stored flag and sizes disagree.")
		largest = n_tracks * header.tile * 8 + 16 * n_tracks + 64
		if (raws > largest).any():
			raise FormatError("a chunk is larger than any chunk of its group can "
				"be.")

		offsets = numpy.zeros(len(tiles), dtype=numpy.int64)
		covered = numpy.zeros(len(tiles), dtype=numpy.bool_)
		for run in runs:
			first, last, offset, n_bytes = (int(run[name]) for name in RUN.names)
			if first > last or last >= self.n_tiles or offset + n_bytes > \
					header.length:
				raise FormatError("a run is out of order or outside the file.")
			lo = numpy.searchsorted(tiles, first)
			hi = numpy.searchsorted(tiles, last, side='right')
			if covered[lo:hi].any():
				raise FormatError("two runs cover one tile.")
			chunk_sizes = sizes[lo:hi]
			if int(chunk_sizes.sum()) != n_bytes:
				raise FormatError("a run's chunks do not add up to its bytes.")
			covered[lo:hi] = True
			offsets[lo:hi] = offset + numpy.cumsum(chunk_sizes) - chunk_sizes
		if not covered.all():
			raise FormatError("a live tile lies in no run.")
		order = numpy.argsort(runs['offset'], kind='stable')
		ends = runs['offset'][order] + runs['bytes'][order]
		if (runs['offset'][order][1:] < ends[:-1]).any():
			raise FormatError("two runs overlap in the file.")
		group.offsets = offsets

	def _check_blocks(self, blocks):
		lengths = numpy.array(list(self.chrom_sizes.values()), dtype=numpy.int64)
		header = self.header
		if (blocks['chrom'] >= len(lengths)).any() or (blocks['n'] == 0).any() \
				or (blocks['n'] > BLOCK_ENTRIES).any() or (blocks['first'] > blocks[
				'last']).any() or (blocks['kind'] > 255).any():
			raise FormatError("a block record is out of range.")
		if (blocks['last'] >= lengths[blocks['chrom']]).any():
			raise FormatError("a block ends past its chromosome.")
		kinds = blocks['kind']
		if ((kinds & KIND_MASK) != KIND_DENSE).any() or (((kinds >> CODE_SHIFT)
				& CODE_MASK) > CODE_F64).any() or (kinds & STORED).any():
			raise FormatError("a block's kind byte is not one the format defines.")
		if (blocks['offset'] + blocks['size'] > header.length).any():
			raise FormatError("a block lies outside the file.")
		if header.codec == CODEC_NONE and (blocks['size'] != blocks['raw']).any():
			raise FormatError("an uncompressed file's block sizes disagree.")
		if (blocks['raw'] > 12 * blocks['n'].astype(numpy.int64) + 64).any():
			raise FormatError("a block is larger than its entries can be.")
		keys = (blocks['chrom'].astype(numpy.int64) << 32) | blocks['first']
		same = blocks['chrom'][1:] == blocks['chrom'][:-1]
		if (numpy.diff(keys) <= 0).any() or (same & (blocks['first'][1:] <=
				blocks['last'][:-1])).any():
			raise FormatError("a track's blocks are out of order.")

	# ---- chunks and blocks ----

	def chunk(self, g, k):
		"""The decoded bytes of live chunk k of group g, checked against the
		index's sizes and CRC-32."""

		group, header = self.groups[g], self.header
		kind = int(group.live['kind'][k])
		size, raw_size = int(group.live['size'][k]), int(group.live['raw'][k])
		at = int(group.offsets[k])
		raw = self.bytes[at:at + size]
		if zlib.crc32(raw) != int(group.live['crc'][k]):
			raise FormatError("a chunk does not match its CRC-32.")
		if header.codec == CODEC_ZLIB and not kind & STORED:
			raw = inflate(raw, raw_size)
		if len(raw) != raw_size or raw_size % 8:
			raise FormatError("a chunk's bytes are not its raw size, a multiple "
				"of 8.")
		return raw

	def block(self, t, k):
		"""The decoded bytes of block k of track t."""

		record = self.groups[t].blocks[k]
		at, size = int(record['offset']), int(record['size'])
		raw = self.bytes[at:at + size]
		if zlib.crc32(raw) != int(record['crc']):
			raise FormatError("a block does not match its CRC-32.")
		if self.header.codec == CODEC_ZLIB:
			raw = inflate(raw, int(record['raw']))
		if len(raw) != int(record['raw']) or len(raw) % 8:
			raise FormatError("a block's bytes are not its raw size, a multiple "
				"of 8.")
		return raw

	def dense(self):
		"""Every track's values over every chromosome, as one (tracks,
		length) float64 array per chromosome name."""

		header = self.header
		lengths = list(self.chrom_sizes.values())
		out = {name: numpy.zeros((header.n_tracks, length)) for name, length in
			self.chrom_sizes.items()}
		arrays = list(out.values())
		starts = self.tile_offsets
		if header.order == 'tracks':
			for t, group in enumerate(self.groups):
				for k, record in enumerate(group.blocks):
					positions, values = decode_block(self.block(t, k), int(record[
						'kind']), int(record['n']))
					if positions[0] != record['first'] or positions[-1] != record[
							'last']:
						raise FormatError("a block's positions are not its record's.")
					arrays[int(record['chrom'])][t, positions] = values
			return out

		for g, group in enumerate(self.groups):
			members = self.group_tracks[g]
			for k, tile in enumerate(group.live['tile']):
				tid = int(numpy.searchsorted(starts, tile, side='right') - 1)
				base = int(tile - starts[tid]) * header.tile
				values = decode_chunk(self.chunk(g, k), int(group.live['kind'][k]),
					len(members), header.tile)
				width = min(header.tile, lengths[tid] - base)
				arrays[tid][members, base:base + width] = values[:, :width]
		return out


def element_values(data, at, code, n):
	"""n values of element type `code` at byte `at`, as float64; the "one"
	type has no bytes and every value 1."""

	if code == CODE_ONE:
		return numpy.ones(n), at
	width = ELEMENT_WIDTHS[code]
	if at + n * width > len(data):
		raise FormatError("a chunk ends inside its values.")
	values = numpy.frombuffer(data, dtype=ELEMENT_DTYPES[code], count=n,
		offset=at).astype(numpy.float64)
	return values, at + n * width


def decode_chunk(data, kind_byte, n_tracks, tile):
	"""One chunk's values, (n_tracks, tile) float64, from its decoded
	bytes."""

	kind, code = kind_byte & KIND_MASK, (kind_byte >> CODE_SHIFT) & CODE_MASK
	if kind in (KIND_ZERO,) or kind > KIND_RUNS or code > CODE_F64:
		raise FormatError("a kind byte is not one the format defines.")
	out = numpy.zeros((n_tracks, tile))
	if kind == KIND_DENSE:
		if code == CODE_ONE:
			raise FormatError("a dense chunk cannot have the one element type.")
		values, _ = element_values(data, 0, code, n_tracks * tile)
		out[:] = values.reshape(n_tracks, tile)
		return out

	if kind == KIND_MATRIX:
		if len(data) < 4:
			raise FormatError("a matrix chunk is shorter than its header.")
		n_present = struct.unpack_from('<I', data, 0)[0]
		if n_present > n_tracks or len(data) < 8 + 8 * n_present:
			raise FormatError("a matrix chunk is shorter than its header.")
		tracks = numpy.frombuffer(data, dtype='<u4', count=n_present, offset=4)
		ptr = numpy.frombuffer(data, dtype='<u4', count=n_present + 1,
			offset=4 + 4 * n_present).astype(numpy.int64)
		total = int(ptr[-1])
		if ptr[0] != 0 or (numpy.diff(ptr) < 0).any() or (tracks >= n_tracks
				).any() or (numpy.diff(tracks.astype(numpy.int64)) <= 0).any():
			raise FormatError("a matrix chunk's tracks or pointers are invalid.")
		at = 8 + 8 * n_present
		offsets = numpy.frombuffer(data, dtype='<u2', count=total, offset=at
			).astype(numpy.int64)
		values, _ = element_values(data, pad4(at + 2 * total), code, total)
		for j, g in enumerate(tracks):
			lo, hi = int(ptr[j]), int(ptr[j + 1])
			here = offsets[lo:hi]
			if (here >= tile).any() or (numpy.diff(here) <= 0).any():
				raise FormatError("a matrix chunk's offsets are out of range or "
					"order.")
			out[int(g), here] = values[lo:hi]
		return out

	# sparse or runs
	if kind == KIND_RUNS and code == CODE_ONE:
		raise FormatError("a runs chunk cannot have the one element type.")
	if len(data) < 4 + 4 * n_tracks:
		raise FormatError("a sparse chunk is shorter than its header.")
	total = struct.unpack_from('<I', data, 0)[0]
	lengths = numpy.frombuffer(data, dtype='<u4', count=n_tracks, offset=4
		).astype(numpy.int64)
	at = 4 + 4 * n_tracks
	values_at = pad4(at + int(lengths.sum()))
	values, _ = element_values(data, values_at, code, total)
	d = 0
	for g in range(n_tracks):
		end = at + int(lengths[g])
		p = 0
		if kind == KIND_RUNS:
			current, since = 0.0, 0
		while at < end:
			delta, at = varint(data, at, end)
			p += delta
			if p >= tile:
				raise FormatError("an offset lies past the tile.")
			if d >= total:
				raise FormatError("a sparse chunk holds more offsets than its "
					"total.")
			if kind == KIND_RUNS:
				out[g, since:p] = current
				current, since = values[d], p
			else:
				out[g, p] = values[d]
			d += 1
		if kind == KIND_RUNS:
			out[g, since:] = current
	if d != total:
		raise FormatError("a sparse chunk's offsets do not add up to its total.")
	return out


def decode_block(data, kind_byte, n):
	"""A track-order block's (positions, values)."""

	kind, code = kind_byte & KIND_MASK, (kind_byte >> CODE_SHIFT) & CODE_MASK
	if kind != KIND_DENSE or code > CODE_F64:
		raise FormatError("a block's kind byte is not one the format defines.")
	if len(data) < pad8(4 * n) + n * ELEMENT_WIDTHS[code]:
		raise FormatError("a block is shorter than its entries.")
	positions = numpy.frombuffer(data, dtype='<u4', count=n).astype(numpy.int64)
	if (numpy.diff(positions) <= 0).any():
		raise FormatError("a block's positions are not ascending.")
	values, _ = element_values(data, pad8(4 * n), code, n)
	return positions, values
