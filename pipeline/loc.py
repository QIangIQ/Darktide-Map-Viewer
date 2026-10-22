"""English UI strings from the game (limn `strings` output in cache/strings, keys are IdString32 of loc keys)."""
import os, json, glob
from dtfmt import CACHE, id32

_loc = None


def table():
    global _loc
    if _loc is None:
        _loc = {}
        for f in glob.glob(os.path.join(CACHE, 'strings', '*.english.json')):
            try:
                _loc.update(json.load(open(f, encoding='utf-8')))
            except (OSError, ValueError):
                pass
    return _loc


def loc(key, default=None):
    if not key:
        return default
    return table().get('%08x' % id32(key), default)
