# contact sheet: sheet.py spec.json   spec = {"out": png, "cols": n, "tw": tile width, "items": [[file, label], ...]}
import sys, json
from PIL import Image, ImageDraw, ImageFont
sp = json.load(open(sys.argv[1])); items = sp['items']; cols = sp['cols']; tw = sp['tw']
ims = [Image.open(f).convert('RGB') for f, _ in items]
th = int(tw * ims[0].height / ims[0].width); rows = (len(ims) + cols - 1) // cols
sh = Image.new('RGB', (cols * tw, rows * th), (20, 20, 20)); d = ImageDraw.Draw(sh)
try: font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', max(11, tw // 26))
except Exception: font = ImageFont.load_default()
for i, im in enumerate(ims):
    x, y = (i % cols) * tw, (i // cols) * th; sh.paste(im.resize((tw, th), Image.LANCZOS), (x, y)); lab = items[i][1]
    if lab:
        w = d.textlength(lab, font=font); d.rectangle((x, y, x + w + 8, y + font.size + 6), fill=(0, 0, 0)); d.text((x + 4, y + 2), lab, font=font, fill=(235, 235, 235))
sh.save(sp['out']); print('sheet', sp['out'], sh.size)
