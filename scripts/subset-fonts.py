"""Regenerate checked-in Latin font subsets from the installed geist package.
Optional maintenance tool: requires fonttools and brotli, not needed to build/run.
"""
from pathlib import Path
from shutil import copyfile
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
source = root / 'node_modules/geist'
output = root / 'app/fonts'
output.mkdir(exist_ok=True)
# Latin, punctuation, arrows, currency, and common symbols used by this UI.
unicodes = set(range(0x0000, 0x0100)) | set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200))
unicodes |= {0x0131, 0x0152, 0x0153, 0x02BB, 0x02BC, 0x02C6, 0x02DA, 0x02DC, 0x20AC, 0x2122, 0x2212, 0xFEFF, 0xFFFD}
for directory, name, target in [('geist-sans', 'Geist', 'geist-sans-latin'), ('geist-mono', 'GeistMono', 'geist-mono-latin')]:
    font = TTFont(source / f'dist/fonts/{directory}/{name}-Variable.woff2')
    options = subset.Options()
    options.hinting = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    font.flavor = 'woff2'
    font.save(output / f'{target}.woff2')
copyfile(source / 'LICENSE.txt', output / 'LICENSE.txt')
