"""hash -> readable name table from the Darktide source tree (paths + string literals)."""
import os,re,glob,pickle
from dtfmt import SOURCE,CACHE,murmur64
def build():
    names={}
    pat=re.compile(r'"((?:content|core|wwise|packages|scripts)/[A-Za-z0-9_/\-\.]+)"')
    for p in glob.glob(SOURCE+'/**/*.lua',recursive=True):
        rel=os.path.relpath(p,SOURCE).replace(os.sep,'/')[:-4]
        for cand in (rel,os.path.dirname(rel)):
            names[murmur64(cand)]=cand
        for suf in ('_main_path','_volume_data','_nav_base','_mission_themes','/world_volume_data','/world_main_path'):
            if rel.endswith(suf):
                b=rel[:-len(suf)];names[murmur64(b)]=b;names[murmur64(b+'/world')]=b+'/world'
        try: txt=open(p,encoding='utf8',errors='ignore').read()
        except OSError: continue
        for m in pat.findall(txt): names[murmur64(m)]=m
    pickle.dump(names,open(os.path.join(CACHE,'names.pkl'),'wb'))
    return names
if __name__=='__main__':
    n=build();print(len(n),'names')
