import struct,os,pickle,collections
from dtfmt import CACHE,murmur64
EXTS=['unit','level','texture','material','package','lua','physics','shading_environment','particles','wwise_bank','wwise_dep','navdata','entity','bones','state_machine','animation','strings','font','config','data','render_config','shader_library','shader_library_group','sound_environment','vector_field','ivf','wwise_stream','wwise_metadata','flow','surface_properties','mouse_cursor','network_config','apb','timpani_bank','scene','camera','keys']
def kinds():
    p=os.path.join(CACHE,'kinds.pkl')
    if os.path.exists(p): return pickle.load(open(p,'rb'))
    en={murmur64(e):e for e in EXTS}
    d=open(os.path.join(CACHE,'hashes.bin'),'rb').read();k=collections.defaultdict(set)
    for i in range(0,len(d),16):
        e,n=struct.unpack_from('<QQ',d,i);k[n].add(en.get(e,'%016x'%e))
    k=dict(k);pickle.dump(k,open(p,'wb'));return k
