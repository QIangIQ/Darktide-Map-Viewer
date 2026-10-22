"""(Re)extract raw Darktide resources from the game bundles into cache/ with limn, then rebuild indexes.
Run with the game closed. Needed once, and again after every game update."""
import os, sys, json, time, shutil, subprocess
from dtfmt import ROOT, CACHE, RAW, BUNDLE

LIMN = os.path.join(ROOT, 'tools', 'limn.exe')
T0 = time.time()


def log(stage, msg='', **kw):
    print(json.dumps(dict(stage=stage, msg=msg, t=round(time.time() - T0, 1), **kw)), flush=True)


def main():
    if not os.path.exists(LIMN):
        raise SystemExit('tools/limn.exe missing')
    os.makedirs(RAW, exist_ok=True)
    for t in ('level', 'unit', 'material', 'texture'):
        log('extract', 'limn --dump-raw %s' % t)
        subprocess.run([LIMN, '-i', BUNDLE, '-o', RAW, '--dump-raw', t], cwd=os.path.join(ROOT, 'tools'),
                       check=True, stdout=subprocess.DEVNULL)
    log('extract', 'localization strings')
    subprocess.run([LIMN, '-i', BUNDLE, '-o', os.path.join(CACHE, 'strings'), 'strings'], cwd=os.path.join(ROOT, 'tools'),
                   check=True, stdout=subprocess.DEVNULL)
    log('extract', 'resource hash list')
    subprocess.run([LIMN, '-i', BUNDLE, '-o', RAW, '--dump-hashes', '*'], cwd=os.path.join(ROOT, 'tools'),
                   check=True, stdout=subprocess.DEVNULL)
    shutil.move(os.path.join(ROOT, 'tools', 'hashes.bin'), os.path.join(CACHE, 'hashes.bin'))
    for f in ('kinds.pkl', 'names.pkl'):
        p = os.path.join(CACHE, f)
        if os.path.exists(p):
            os.remove(p)
    import kinds, names
    kinds.kinds(); names.build()
    log('done', 'cache ready')


if __name__ == '__main__':
    main()
