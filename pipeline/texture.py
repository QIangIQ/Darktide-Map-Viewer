"""Darktide texture -> RGBA image.

Layout from dacp texture_writer.cpp (write_native_texture_rgba / texture_body_as_kind1 / tile_surface):
  kind 1 body: u32 1, u32 packed, u32 dds_size, Oodle(DDS with resident mips), u32 67, u32 flags,
               u32 streamed_mip_count, u32 w, u32 h, 16 x (u32 off, u32 size), u32 meta, u32 nchunks,
               u16 0, u16 nchunks, nchunks x u32 cumulative compressed end, u32 footer
  kind 0 body: u32 0,0,0, plain DDS, 148-byte mip block, ...
  Streamed mips live in the resource's .stream file as Oodle-packed 64 KiB chunks; each chunk is a
  (128 or 64 blocks wide) x 64 blocks tile, tiles in row-major order, mips largest first.
"""
import struct
import numpy as np
import texture2ddecoder as t2d
from dtfmt import read_resource, read_stream, oodle_decompress, raw_path

# DXGI format -> (block bytes or None for uncompressed, bytes per pixel, decoder name)
DXGI = {
    71: (8, 'bc1'), 72: (8, 'bc1'), 74: (16, 'bc2'), 75: (16, 'bc2'), 77: (16, 'bc3'), 78: (16, 'bc3'),
    80: (8, 'bc4'), 81: (8, 'bc4'), 83: (16, 'bc5'), 84: (16, 'bc5'), 95: (16, 'bc6'), 96: (16, 'bc6'),
    98: (16, 'bc7'), 99: (16, 'bc7'),
    28: (None, 'rgba8'), 29: (None, 'rgba8'), 87: (None, 'bgra8'), 91: (None, 'bgra8'),
    61: (None, 'r8'), 49: (None, 'rg8'),
}
FOURCC = {b'DXT1': 71, b'DXT3': 74, b'DXT5': 77, b'ATI1': 80, b'BC4U': 80, b'ATI2': 83, b'BC5U': 83}
SRGB = {72, 75, 78, 99, 29, 91}


def parse_dds(dds):
    assert dds[:4] == b'DDS ', 'not a DDS'
    h, w = struct.unpack_from('<II', dds, 12)
    mips = max(1, struct.unpack_from('<I', dds, 28)[0])
    pf_flags = struct.unpack_from('<I', dds, 80)[0]
    fourcc = dds[84:88]
    off = 128
    if fourcc == b'DX10':
        fmt = struct.unpack_from('<I', dds, 128)[0]; off = 148
    elif fourcc in FOURCC:
        fmt = FOURCC[fourcc]
    elif pf_flags & 0x40:  # RGB
        bits = struct.unpack_from('<I', dds, 88)[0]
        rmask = struct.unpack_from('<I', dds, 92)[0]
        fmt = 28 if (bits == 32 and rmask == 0xff) else 87 if bits == 32 else 0
    elif pf_flags & 0x20000:  # luminance
        fmt = 61
    else:
        fmt = 0
    return w, h, mips, fmt, off


def mip_bytes(w, h, fmt):
    blk, kind = DXGI[fmt]
    if blk:
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * blk
    bpp = {'rgba8': 4, 'bgra8': 4, 'r8': 1, 'rg8': 2}[kind]
    return w * h * bpp


def decode(data, w, h, fmt):
    """-> HxWx4 uint8 RGBA"""
    blk, kind = DXGI[fmt]
    if kind == 'rgba8':
        return np.frombuffer(data, np.uint8, w * h * 4).reshape(h, w, 4).copy()
    if kind == 'bgra8':
        a = np.frombuffer(data, np.uint8, w * h * 4).reshape(h, w, 4)
        return a[..., [2, 1, 0, 3]].copy()
    if kind == 'r8':
        a = np.frombuffer(data, np.uint8, w * h).reshape(h, w)
        return np.dstack([a, a, a, np.full_like(a, 255)])
    if kind == 'rg8':
        a = np.frombuffer(data, np.uint8, w * h * 2).reshape(h, w, 2)
        return np.dstack([a[..., 0], a[..., 1], np.zeros_like(a[..., 0]), np.full_like(a[..., 0], 255)])
    pw, ph = max(4, (w + 3) // 4 * 4), max(4, (h + 3) // 4 * 4)
    fn = {'bc1': t2d.decode_bc1, 'bc3': t2d.decode_bc3, 'bc4': t2d.decode_bc4,
          'bc5': t2d.decode_bc5, 'bc6': t2d.decode_bc6, 'bc7': t2d.decode_bc7}[kind]
    bgra = np.frombuffer(fn(bytes(data), pw, ph), np.uint8).reshape(ph, pw, 4)[:h, :w]
    out = bgra[..., [2, 1, 0, 3]].copy()
    if kind == 'bc4':
        out[..., 1] = out[..., 0]; out[..., 2] = out[..., 0]; out[..., 3] = 255
    return out


def untile(chunks, w, h, blk):
    bw, bh = w // 4, h // 4
    cbw, cbh = (128 if blk == 8 else 64), 64
    row = bw * blk
    out = bytearray(row * bh)
    ci = 0
    crow = cbw * blk
    for by in range(0, bh, cbh):
        for bx in range(0, bw, cbw):
            c = chunks[ci]; ci += 1
            x = bx * blk
            for r in range(cbh):
                s = (by + r) * row + x
                out[s:s + crow] = c[r * crow:(r + 1) * crow]
    return bytes(out)


def chunk_count(w, h, blk):
    cbw = 128 if blk == 8 else 64
    return max(1, (w // 4) // cbw) * max(1, (h // 4) // 64)


def load_texture(h, max_size=2048):
    """Return (rgba ndarray, info dict) for texture resource hash h at the largest mip <= max_size."""
    body, sname = read_resource(raw_path(h, 'texture'))
    kind = struct.unpack_from('<I', body, 0)[0]
    if kind == 1:
        packed, dsz = struct.unpack_from('<II', body, 4)
        dds = oodle_decompress(body[12:12 + packed], dsz)
        p = 12 + packed
        marker, flags, sc, W, H = struct.unpack_from('<5I', body, p)
        assert marker == 67, 'mip marker'
        p += 20
        mtab = [struct.unpack_from('<II', body, p + 8 * i) for i in range(16)]
        p += 128
        meta = struct.unpack_from('<I', body, p)[0]; p += 4
        cum = []
        if meta >= 8:
            nch = struct.unpack_from('<I', body, p)[0]; p += 8  # u32 n, u16 0, u16 n
            cum = list(struct.unpack_from('<%dI' % nch, body, p))
    else:
        dds = body[12:]
        sc, cum = 0, []
        H, W = struct.unpack_from('<II', dds, 12)
    dw, dh, dmips, fmt, doff = parse_dds(dds)
    if fmt not in DXGI or DXGI[fmt][1] == 'bc6':
        raise ValueError('unsupported DXGI format %d' % fmt)
    blk = DXGI[fmt][0]
    # full mip chain dims from the top
    dims = []
    w_, h_ = W, H
    while len(dims) < sc + dmips:
        dims.append((w_, h_))
        if w_ == 1 and h_ == 1:
            break
        w_, h_ = max(1, w_ // 2), max(1, h_ // 2)
    # choose mip
    mi = 0
    while mi + 1 < len(dims) and max(dims[mi]) > max_size:
        mi += 1
    if mi < sc and cum:
        stream = read_stream(sname)
        first = sum(chunk_count(*dims[i], blk) for i in range(mi))
        n = chunk_count(*dims[mi], blk)
        chunks = []
        for j in range(first, first + n):
            a = cum[j - 1] if j else 0
            chunks.append(oodle_decompress(stream[a:cum[j]], 65536))
        data = untile(chunks, dims[mi][0], dims[mi][1], blk)
    else:
        mi = max(mi, sc)
        off = doff
        for i in range(sc, mi):
            off += mip_bytes(*dims[i], fmt)
        data = dds[off:off + mip_bytes(*dims[mi], fmt)]
    img = decode(data, dims[mi][0], dims[mi][1], fmt)
    return img, dict(fmt=fmt, srgb=fmt in SRGB, kind=DXGI[fmt][1], w=dims[mi][0], h=dims[mi][1], full=(W, H))
