meta:
  id: figwig
  title: figwig file, version 1
  file-extension: fw
  license: MIT
  endian: le
  ks-version: "0.10"
doc: Adapted from Jacob Schreiber's Figwig v1 schema, pinned at
  c0e5d6522c677b9f03cd6831e2dbcea759866628. See schema/README.md for adaptations and
  validation boundaries.
seq: []
types:
  header:
    doc: The 128-byte header.
    seq:
      - id: magic
        contents: FIGW
      - id: version
        type: u2
        doc: 1
      - id: flags
        type: u2
        doc: Bit 0 set for track order; other bits unknown to version 1.
      - id: tile
        type: u4
        doc: Bases per tile, a power of two from 16 to 65536.
      - id: codec
        type: u2
        doc: 0 for chunks stored as they are, 1 for zlib streams.
      - id: level
        type: u2
        doc: The compression level the chunks were written at.
      - id: n_chroms
        type: u4
      - id: n_tracks
        type: u4
      - id: n_groups
        type: u4
        doc: Equal to n_tracks in track order.
      - id: tables_crc
        type: u4
        doc: CRC-32 of the bytes from the chromosome table to the end of the index's directory.
      - id: chroms_offset
        type: u8
      - id: tracks_offset
        type: u8
        doc: Offset of the statistics table.
      - id: index_offset
        type: u8
      - id: data_offset
        type: u8
        doc: Always 128, where the first chunk may start.
      - id: metadata_offset
        type: u8
      - id: metadata_length
        type: u8
      - id: zooms_offset
        type: u8
        doc: Reserved, 0; zoom levels lie in the index records.
      - id: length
        type: u8
        doc: The bytes of the file that the format uses; later bytes are ignored.
      - id: required
        type: u4
        doc: Feature bits a reader must know; none is defined in version 1.
      - id: optional
        type: u4
        doc: Feature bits a reader may ignore; bit 0 says each record ends with a zoom section.
      - id: header_crc
        type: u4
        doc: CRC-32 of these 128 bytes with this field as 0.
      - id: padding
        size: 20
    instances:
      track_order:
        value: flags & 1 != 0
      has_zooms:
        value: optional & 1 != 0
  chrom:
    seq:
      - id: len_name
        type: u2
      - id: name
        type: str
        size: len_name
        encoding: UTF-8
      - id: length
        type: u8
        doc: Bases, from 1 to 2**32 - 1.
  track_stats:
    doc: One track's statistics over its non-NaN bases.
    seq:
      - id: sum
        type: f8
      - id: nonzero
        type: u8
      - id: min
        type: f8
      - id: max
        type: f8
  run:
    doc: The chunks of tiles first to last, back to back from offset for bytes bytes.
    seq:
      - id: first
        type: u8
      - id: last
        type: u8
      - id: offset
        type: u8
      - id: bytes
        type: u8
  block_record:
    doc: One track-order block, its chromosome, first and last position, entries, place and
      kind.
    seq:
      - id: chrom
        type: u4
      - id: first
        type: u4
      - id: last
        type: u4
      - id: num_entries
        type: u4
      - id: offset
        type: u8
      - id: len_body
        type: u4
        doc: The block's bytes in the file, compressed in a codec 1 file.
      - id: raw
        type: u4
        doc: The block's bytes once decoded.
      - id: kind
        type: u4
        doc: The kind byte, in a u4; kind 1 with an element code.
      - id: crc
        type: u4
  live_tiles:
    doc: |
      The tiles that hold values, ascending, with each one's kind byte,
      compressed size, uncompressed size and the CRC-32 of its bytes as
      they lie in the file; laid out as five arrays, one per field.
    params:
      - id: num_tiles
        type: u4
    seq:
      - id: tiles
        type: u4
        repeat: expr
        repeat-expr: num_tiles
      - id: kinds
        type: u1
        repeat: expr
        repeat-expr: num_tiles
      - id: sizes
        type: u4
        repeat: expr
        repeat-expr: num_tiles
      - id: raws
        type: u4
        repeat: expr
        repeat-expr: num_tiles
      - id: crcs
        type: u4
        repeat: expr
        repeat-expr: num_tiles
  summary_stream:
    params:
      - id: num_tiles
        type: u4
    seq:
      - id: tiles
        type: u4
        repeat: expr
        repeat-expr: num_tiles
      - id: sums
        type: f4
        repeat: eos
        doc: n times the group's tracks, tile by tile.
  zoom_stream:
    params:
      - id: num_bins
        type: u4
    seq:
      - id: bins
        type: u4
        repeat: expr
        repeat-expr: num_bins
      - id: sums
        type: f8
        repeat: eos
        doc: n times the group's tracks, bin by bin.
  element_values:
    doc: |
      n values of the element type, as an empty list for the "one" type,
      7, which stores none and whose every value is 1.
    params:
      - id: code
        type: u1
      - id: n
        type: u4
    seq:
      - id: values
        type:
          switch-on: code
          cases:
            "0": u1
            "1": u2
            "2": u4
            "3": s1
            "4": s2
            "5": s4
            "6": f4
            "7": u1
            "8": f8
        repeat: expr
        repeat-expr: "code == 7 ? 0 : n"
  varint:
    doc: A LEB128 varint of at most three bytes, low seven bits first.
    seq:
      - id: groups
        type: varint_group
        repeat: until
        repeat-until: not _.has_next or groups.size == 3
    instances:
      value:
        value: "groups[0].low + (groups.size >= 2 ? (groups[1].low << 7) : 0) + (groups.size >= 3
          ? (groups[2].low << 14) : 0)"
  varint_group:
    seq:
      - id: b
        type: u1
    instances:
      has_next:
        value: b & 0x80 != 0
      low:
        value: b & 0x7f
  group_prefix:
    seq:
      - id: num_entries
        type: u4
      - id: crc
        type: u4
  live_header:
    seq:
      - id: n_live
        type: u4
      - id: len_live
        type: u4
  summary_header:
    seq:
      - id: n_sum
        type: u4
      - id: len_stream
        type: u4
      - id: crc
        type: u4
  zoom_header:
    seq:
      - id: factor
        type: u4
      - id: n
        type: u4
      - id: len_stream
        type: u4
      - id: crc
        type: u4
  u16_array:
    params:
      - id: n
        type: u4
    seq:
      - id: values
        type: u2
        repeat: expr
        repeat-expr: n
  u32_array:
    params:
      - id: n
        type: u4
    seq:
      - id: values
        type: u4
        repeat: expr
        repeat-expr: n
  directory:
    params:
      - id: n_groups
        type: u4
    seq:
      - id: offsets
        type: u8
        repeat: expr
        repeat-expr: n_groups
  zoom_count:
    seq:
      - id: count
        type: u4
