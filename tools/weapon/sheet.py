# contact sheet: sheet.py out.png cols tile_w img...
import sys
from PIL import Image
out, cols, tw = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); ims = [Image.open(f).convert('RGB') for f in sys.argv[4:]]
th = int(tw * ims[0].height / ims[0].width); rows = (len(ims) + cols - 1) // cols
sh = Image.new('RGB', (cols * tw, rows * th), (20, 20, 20))
for i, im in enumerate(ims): sh.paste(im.resize((tw, th), Image.LANCZOS), ((i % cols) * tw, (i // cols) * th))
sh.save(out); print('sheet', out, sh.size)
