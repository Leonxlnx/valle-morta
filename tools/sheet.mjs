// Contact sheet: node tools/sheet.mjs out.jpg <tileWidth> <cols> a.jpg b.jpg ...
import { execFileSync } from 'node:child_process';

const [out, tileW, cols, ...files] = process.argv.slice(2);
const n = files.length, C = Number(cols);
const inputs = files.flatMap((f) => ['-i', f]);
let filter = files.map((_, i) => `[${i}:v]scale=${tileW}:-2[s${i}]`).join(';');
if (n === 1) {
  filter = `[0:v]scale=${tileW}:-2[o]`;
} else {
  const layout = files.map((_, i) => {
    const c = i % C, r = Math.floor(i / C);
    const x = c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+');
    const y = r === 0 ? '0' : Array.from({ length: r }, (_, k) => `h${k * C}`).join('+');
    return `${x}_${y}`;
  });
  filter += `;${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${n}:layout=${layout.join('|')}[o]`;
}
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[o]', '-q:v', '3', out], { stdio: 'inherit' });
console.log(out);
