"""Build several missions in one queue (keeps going when one fails). usage: build_all.py [--tex-max N] key ..."""
import sys, json, time, argparse, traceback
import build_map

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('keys', nargs='*')
    ap.add_argument('--tex-max', type=int, default=1024)
    a = ap.parse_args()
    keys = a.keys or list(build_map.OV.mission_templates())
    failed = []
    for i, k in enumerate(keys):
        print(json.dumps(dict(stage='queue', msg='%s (%d/%d)' % (k, i + 1, len(keys)), done=i, total=len(keys))), flush=True)
        try:
            build_map.build(k, a.tex_max)
        except BaseException as e:
            failed.append(k)
            print(json.dumps(dict(stage='queue', msg='%s failed: %s' % (k, repr(e)[:200]))), flush=True)
    print(json.dumps(dict(stage='done', msg='%d built, %d failed %s' % (len(keys) - len(failed), len(failed), failed))), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':  # required: texture workers re-import the main module on Windows
    main()
