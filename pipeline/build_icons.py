"""Decode the ability and class icons that Strikemap shows on its radius circles, from your own game files.

usage: python build_icons.py        (needs the cache from extract.py)
Output: packs/_icons/<name>.png (128 px). Derived from the game: personal use only, never commit or share them.
"""
import os, sys, json, time
import numpy as np
from PIL import Image
from dtfmt import ROOT, murmur64, have_raw
import texture

OUT = os.path.join(ROOT, 'packs', '_icons')
HUD = 'content/ui/textures/icons/abilities/hud/'
ICONS = {
    # ability icons: the hud_icon of each ability in scripts/settings/ability/player_abilities/abilities/*.lua
    'veteran_ability_voice_of_command': HUD + 'veteran/veteran_ability_voice_of_command',
    'psyker_shout_vent_warp_charge': HUD + 'psyker/psyker_shout_vent_warp_charge',
    'ogryn_ability_taunt': HUD + 'ogryn/ogryn_ability_taunt',
    'adamant_ability_shout': HUD + 'adamant/adamant_ability_shout',
    'zealot_ability_bolstering_prayer': HUD + 'zealot/zealot_ability_bolstering_prayer',
    # class icons
    'class_veteran': 'content/ui/textures/icons/classes/veteran',
    'class_zealot': 'content/ui/textures/icons/classes/zealot',
    'class_psyker': 'content/ui/textures/icons/classes/psyker',
    'class_ogryn': 'content/ui/textures/icons/classes/ogryn',
    'class_adamant': 'content/ui/textures/icons/classes/adamant',
}


def main():
    os.makedirs(OUT, exist_ok=True)
    done, missing = [], []
    for name, path in ICONS.items():
        h = murmur64(path)
        if not have_raw(h, 'texture'):
            missing.append(name)
            continue
        img, info = texture.load_texture(h, 128)
        Image.fromarray(np.asarray(img, dtype=np.uint8)).save(os.path.join(OUT, name + '.png'))
        done.append(name)
    print(json.dumps(dict(stage='done', msg='%d icons written, missing: %s' % (len(done), missing or 'none'))), flush=True)


if __name__ == '__main__':
    main()
