"""Darktide Map Viewer - local server.

Serves viewer/ at /, packs/ at /packs/, and a small API used by the mission menu:
  GET  /api/missions          mission templates + which packs are built
  POST /api/build             {"key": "...", "tex_max": 1024}  starts pipeline/build_map.py
  GET  /api/build/status      progress of the running / last build
  POST /api/extract           refreshes cache/raw from the game bundles (limn), needed after a game update
Only listens on 127.0.0.1.
"""
import os, sys, json, threading, subprocess, webbrowser, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
PORT = int(os.environ.get('MAPVIEWER_PORT', '8740'))

JOB = dict(running=False, key=None, lines=[], last=None, ok=None, started=None)
LOCK = threading.Lock()


def run_job(cmd, key):
    with LOCK:
        JOB.update(running=True, key=key, lines=[], last=None, ok=None, started=time.time())
    p = subprocess.Popen(cmd, cwd=os.path.join(ROOT, 'pipeline'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    for line in p.stdout:
        line = line.rstrip()
        with LOCK:
            JOB['lines'].append(line)
            JOB['lines'] = JOB['lines'][-200:]
            try:
                JOB['last'] = json.loads(line)
            except ValueError:
                pass
    p.wait()
    with LOCK:
        JOB.update(running=False, ok=p.returncode == 0)


# --- pins (main path pins and triggers placed in the viewer) -------------------------------------------------
# packs/<key>/pins.json holds the pins in Darktide world coordinates.


def save_pins(body):
    import re
    key = str(body.get('pack', ''))
    if not re.fullmatch(r'[A-Za-z0-9_]+', key) or not os.path.isdir(os.path.join(ROOT, 'packs', key)):
        return dict(error='unknown pack')
    pins = body.get('pins', [])
    with open(os.path.join(ROOT, 'packs', key, 'pins.json'), 'w') as f:
        json.dump(pins, f, indent=1)
    out = dict(saved=len(pins))
    return out


class H(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = urlparse(path).path
        if p.startswith('/packs/'):
            return os.path.join(ROOT, 'packs', *p[len('/packs/'):].split('/'))
        rel = p.lstrip('/') or 'index.html'
        return os.path.join(ROOT, 'viewer', *rel.split('/'))

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = urlparse(self.path).path
        if p == '/api/missions':
            import overlays
            tpl = overlays.mission_templates()
            idx = {}
            ip = os.path.join(ROOT, 'packs', 'index.json')
            if os.path.exists(ip):
                idx = {e['key']: e for e in json.load(open(ip))}
            cache_ok = os.path.isdir(os.path.join(ROOT, 'cache', 'raw'))
            return self._json(dict(missions=[dict(key=k, **v, pack=idx.get(k)) for k, v in tpl.items()],
                                   extra=[e for k, e in idx.items() if k not in tpl], cache=cache_ok))
        if p == '/api/build/status':
            with LOCK:
                return self._json(dict(JOB))
        return super().do_GET()

    def do_POST(self):
        p = urlparse(self.path).path
        n = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(n) or b'{}')
        if p == '/api/pins':
            return self._json(save_pins(body))
        with LOCK:
            busy = JOB['running']
        if busy:
            return self._json(dict(error='a job is already running'), 409)
        if p == '/api/build':
            key = str(body.get('key', ''))
            tex = int(body.get('tex_max', 1024))
            cmd = [sys.executable, '-u', 'build_map.py', key, '--tex-max', str(tex)]
            threading.Thread(target=run_job, args=(cmd, key), daemon=True).start()
            return self._json(dict(started=True))
        if p == '/api/buildall':
            keys = [str(k) for k in body.get('keys', [])]
            tex = int(body.get('tex_max', 1024))
            cmd = [sys.executable, '-u', 'build_all.py', '--tex-max', str(tex)] + keys
            threading.Thread(target=run_job, args=(cmd, 'all missions'), daemon=True).start()
            return self._json(dict(started=True))
        if p == '/api/extract':
            cmd = [sys.executable, '-u', 'extract.py']
            threading.Thread(target=run_job, args=(cmd, '__extract__'), daemon=True).start()
            return self._json(dict(started=True))
        self._json(dict(error='unknown endpoint'), 404)


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    url = 'http://127.0.0.1:%d/' % PORT
    print('Darktide Map Viewer at', url, flush=True)
    if '--no-browser' not in sys.argv:
        webbrowser.open(url)
    srv.serve_forever()
