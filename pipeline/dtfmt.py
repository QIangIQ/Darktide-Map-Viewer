"""Shared Darktide (Stingray) resource helpers: resource formats, hashing, Oodle, path settings.

Settings (environment variables, all optional):
  DARKTIDE_ROOT    the Darktide install folder (the one that contains `bundle` and `binaries`); found automatically
                   in the usual Steam library folders when not set
  DARKTIDE_SOURCE  a checkout of the community Darktide Lua source dump; default: <this repo>/Darktide-Source-Code
"""
import os, re, struct, pickle, ctypes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'cache')
RAW = os.path.join(CACHE, 'raw')


def find_game():
    env = os.environ.get('DARKTIDE_ROOT')
    if env:
        return env
    name = 'Warhammer 40,000 DARKTIDE'
    libs = []
    for var in ('ProgramFiles(x86)', 'ProgramFiles'):
        base = os.environ.get(var)
        if base:
            libs.append(os.path.join(base, 'Steam'))
    for steam in list(libs):  # extra Steam libraries are listed in libraryfolders.vdf
        vdf = os.path.join(steam, 'steamapps', 'libraryfolders.vdf')
        if os.path.exists(vdf):
            for m in re.finditer(r'"path"\s+"([^"]+)"', open(vdf, errors='ignore').read()):
                libs.append(m.group(1).replace('\\\\', '\\'))
    found = [os.path.join(lib, 'steamapps', 'common', name) for lib in libs]
    for p in found:  # a real install has the bundle database; an old leftover folder does not
        if os.path.isfile(os.path.join(p, 'bundle', 'bundle_database.data')):
            return p
    for p in found:
        if os.path.isdir(p):
            return p
    return os.path.join(libs[0] if libs else 'C:\\', 'steamapps', 'common', name)  # not found: set DARKTIDE_ROOT


GAME = find_game()
BUNDLE = os.path.join(GAME, 'bundle')
SOURCE = os.environ.get('DARKTIDE_SOURCE') or next(
    (p for p in (os.path.join(ROOT, 'Darktide-Source-Code'), os.path.join(ROOT, 'Darktide-Source-Code-master'))
     if os.path.isdir(p)), os.path.join(ROOT, 'Darktide-Source-Code'))

M = 0xc6a4a7935bd1e995
MASK = (1 << 64) - 1


def murmur64(s, seed=0):
    d = s.encode() if isinstance(s, str) else s
    n = len(d)
    h = (seed ^ (n * M)) & MASK
    i = 0
    while n - i >= 8:
        k = struct.unpack_from('<Q', d, i)[0]
        k = k * M & MASK; k ^= k >> 47; k = k * M & MASK
        h ^= k; h = h * M & MASK; i += 8
    r = n - i
    for j in range(r - 1, -1, -1):
        h ^= d[i + j] << (8 * j)
    if r:
        h = h * M & MASK
    h ^= h >> 47; h = h * M & MASK; h ^= h >> 47
    return h


def id32(s):
    """IdString32 = upper 32 bits of murmur64 (compiler: id32_from_id64)."""
    return murmur64(s) >> 32


def hx(h):
    return '%016x' % h


class R:
    __slots__ = ('d', 'o')

    def __init__(self, d, o=0):
        self.d = d; self.o = o

    def u8(self):
        v = self.d[self.o]; self.o += 1; return v

    def u16(self):
        v = struct.unpack_from('<H', self.d, self.o)[0]; self.o += 2; return v

    def u32(self):
        v = struct.unpack_from('<I', self.d, self.o)[0]; self.o += 4; return v

    def u64(self):
        v = struct.unpack_from('<Q', self.d, self.o)[0]; self.o += 8; return v

    def f(self, n):
        v = struct.unpack_from('<%df' % n, self.d, self.o); self.o += 4 * n; return v

    def blob(self):
        n = self.u32(); b = self.d[self.o:self.o + n]; self.o += n; return b

    def skip(self, n):
        self.o += n


def read_resource(path):
    """Raw limn dump = cooked resource: ext u64, name u64, variants u32=1, 2x u32,
    u8 @28 (1 = body is stored in a bundle data file named by the body), body size u32 @29,
    u8 @33, stream-name size u32 @34, body @38, then the stream name."""
    d = open(path, 'rb').read()
    external = d[28]
    size = struct.unpack_from('<I', d, 29)[0]
    ssz = struct.unpack_from('<I', d, 34)[0]
    body = d[38:38 + size]
    sname = d[38 + size:38 + size + ssz].rstrip(b'\0').decode('ascii', 'replace') if ssz else ''
    if external:
        body = read_stream(body.rstrip(b'\0').decode('ascii'))
    return body, sname


def raw_path(h, ext):
    return os.path.join(RAW, '%s.%s' % (hx(h), ext))


def have_raw(h, ext):
    return os.path.exists(raw_path(h, ext))


def read_stream(sname):
    return open(os.path.join(BUNDLE, sname), 'rb').read()


# ---------------------------------------------------------------- hash index / names
_names = None


def names():
    """hash -> name, from source tree paths and strings (built by names.py)."""
    global _names
    if _names is None:
        p = os.path.join(CACHE, 'names.pkl')
        _names = pickle.load(open(p, 'rb')) if os.path.exists(p) else {}
    return _names


def name_of(h, default=None):
    return names().get(h, default if default is not None else hx(h))


# ---------------------------------------------------------------- Oodle
_oodle = None


def oodle_decompress(src, raw_len):
    global _oodle
    if _oodle is None:
        dll = os.path.join(GAME, 'binaries', 'oo2core_9_win64.dll')
        if not os.path.exists(dll):
            dll = os.path.join(ROOT, 'tools', 'oo2core_9_win64.dll')
        _oodle = ctypes.WinDLL(dll)
        f = _oodle.OodleLZ_Decompress
        f.restype = ctypes.c_longlong
        f.argtypes = [ctypes.c_void_p, ctypes.c_longlong, ctypes.c_void_p, ctypes.c_longlong,
                      ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_longlong,
                      ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_longlong, ctypes.c_int]
    out = ctypes.create_string_buffer(raw_len)
    n = _oodle.OodleLZ_Decompress(src, len(src), out, raw_len, 1, 0, 0, None, 0, None, None, None, 0, 3)
    if n != raw_len:
        raise ValueError('oodle decompress failed (%d of %d)' % (n, raw_len))
    return out.raw
