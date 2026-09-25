// render.mjs: renders studio.html in headless Chromium (GPU via Metal) and captures frames.
//
//   node render.mjs --stills=1.2,3.4 [--dpr=1] --out=out/stills          full-res JPEGs of chosen times
//   node render.mjs --sheet=0.5,1,1.5,2 [--cols=4] [--w=480] --out=out/check/a.jpg   contact sheet
//   node render.mjs --strip=2.0:2.5[:step] [--cols=6] [--w=320] --out=out/check/s.jpg every frame (or every step s)
//   node render.mjs --frames [--range=a:b] [--dpr=2] [--workers=2]        JPEG frames → out/frames (resumable)
//   node render.mjs --encode [--out=out/film.mp4]                          out/frames → H.264 (+ scaled to 1080p)
//   node render.mjs --clip [--range=a:b] --out=out/clip.mp4               straight to MP4 (one page)
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve, extname, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map(a => { a = a.replace(/^--/, ''); const i = a.indexOf('='); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)]; }));
const ROOT = resolve('.');
const FPS = +(args.fps || 30), DPR = +(args.dpr || 1), W = 1920, H = 1080;
const FRAMES_DIR = args.dir || 'out/frames';
const run = (cmd, a) => new Promise((ok, bad) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', c => c ? bad(new Error(cmd + ' exited ' + c)) : ok()); });
const times = s => String(s).split(',').map(Number);

if (args.encode) {
  const out = args.out || 'out/film.mp4';
  const n = readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).length;
  console.log(`encoding ${n} frames → ${out}`);
  const scale = args.scale ? ['-vf', `scale=${args.scale}:flags=lanczos`] : [];
  await run(ffmpegPath, ['-y', '-loglevel', 'error', '-stats', '-framerate', String(FPS), '-i', `${FRAMES_DIR}/f%05d.jpg`, ...scale,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf || 16), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  console.log('wrote ' + out);
  process.exit(0);
}

// ---- static server for the film directory ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = join(ROOT, p === '/' ? '/studio.html' : p);
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(f));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb'],
});
async function openPage(tag = '') {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) || args.verbose) console.log(`[page${tag}]`, m.text()); });
  page.on("pageerror", e => console.log(`[page error${tag}]`, e.message, (e.stack || "").split("\n").slice(0, 4).join(" | ")));
  await page.goto(`${BASE}/studio.html?render&dpr=${DPR}${args.q ? '&' + args.q : ''}`);
  await page.waitForFunction('window.ready === true || window.failed === true', null, { timeout: 180000 });
  if (await page.evaluate(() => window.failed === true)) throw new Error('page failed to build the film');
  const cdp = await ctx.newCDPSession(page);
  return { page, cdp };
}
async function frameAt({ page, cdp }, t, quality = 93) {
  await page.evaluate(t => window.renderAt(t), t);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed: false });
  return Buffer.from(data, 'base64');
}
const duration = p => p.page.evaluate(() => window.DURATION);

async function tile(files, out, cols, w) {
  const tmp = dirname(files[0]);
  const rows = Math.ceil(files.length / cols);
  await run(ffmpegPath, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', `${tmp}/s%04d.jpg`,
    '-vf', `scale=${w}:-1:flags=lanczos,tile=${cols}x${rows}:padding=6:color=0x0b0b0b`, '-frames:v', '1', '-q:v', '3', out]);
}

try {
  if (args.stills) {
    const p = await openPage(), out = args.out || 'out/stills'; mkdirSync(out, { recursive: true });
    console.log('GPU:', await p.page.evaluate(() => window.gpuInfo()));
    for (const s of times(args.stills)) {
      const t0 = Date.now(), buf = await frameAt(p, s, 95);
      const f = `${out}/t${s.toFixed(2).replace('.', '_')}.jpg`; writeFileSync(f, buf);
      console.log(`${f}  ${Date.now() - t0} ms`);
    }
  } else if (args.sheet || args.strip) {
    const p = await openPage(), out = args.out || 'out/check/sheet.jpg'; mkdirSync(dirname(out), { recursive: true });
    let ts;
    if (args.strip) { const [a, b, st] = String(args.strip).split(':').map(Number); const step = st || 1 / FPS; ts = []; for (let x = a; x <= b + 1e-6; x += step) ts.push(+x.toFixed(4)); }
    else ts = times(args.sheet);
    const tmp = `out/.sheet-${process.pid}`; mkdirSync(tmp, { recursive: true });
    const ms = [];
    for (let i = 0; i < ts.length; i++) { const t0 = Date.now(); writeFileSync(`${tmp}/s${String(i).padStart(4, '0')}.jpg`, await frameAt(p, ts[i], 90)); ms.push(Date.now() - t0); }
    await tile(ts.map((_, i) => `${tmp}/s${String(i).padStart(4, '0')}.jpg`), out, +(args.cols || (args.strip ? 6 : 3)), +(args.w || (args.strip ? 320 : 640)));
    rmSync(tmp, { recursive: true, force: true });
    console.log(`${out}  (${ts.length} frames: ${ts.join(', ')})  ms/frame: ${ms.join(' ')}`);
  } else if (args.frames) {
    const probe = await openPage(), len = await duration(probe); await probe.page.context().close();
    const [a, b] = args.range ? String(args.range).split(':').map(Number) : [0, len], workers = +(args.workers || 2);
    mkdirSync(FRAMES_DIR, { recursive: true });
    const first = Math.round(a * FPS), last = Math.min(Math.round(len * FPS) - 1, Math.round(b * FPS) - 1);
    const todo = []; for (let i = first; i <= last; i++) { const f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`; if (!existsSync(f) || statSync(f).size < 1000) todo.push(i); }
    console.log(`${todo.length} frames to render (${last - first + 1 - todo.length} already done), ${workers} workers, dpr ${DPR}`);
    let next = 0, done = 0; const start = Date.now();
    await Promise.all(Array.from({ length: workers }, async (_, w) => {
      const p = await openPage('#' + w);
      while (next < todo.length) {
        const i = todo[next++], f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`;
        const buf = await frameAt(p, i / FPS, 95);
        writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f);
        if (++done % 30 === 0 || done === todo.length) {
          const el = (Date.now() - start) / 1000;
          console.log(`frame ${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
        }
      }
    }));
  } else if (args.clip) {
    const p = await openPage(), len = await duration(p);
    const [a, b] = args.range ? String(args.range).split(':').map(Number) : [0, len];
    const out = args.out || 'out/clip.mp4'; mkdirSync(dirname(out), { recursive: true });
    const scale = DPR !== 1 ? ['-vf', `scale=${W}:${H}:flags=lanczos`] : [];
    const ff = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', ...scale,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(args.crf || 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const n = Math.round((b - a) * FPS), start = Date.now();
    for (let i = 0; i < n; i++) {
      const buf = await frameAt(p, a + i / FPS, 92);
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (i % 30 === 0 || i === n - 1) console.log(`frame ${i + 1}/${n}  ${((Date.now() - start) / (i + 1)).toFixed(0)} ms/frame`);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
    console.log('wrote ' + out);
  }
} finally {
  await browser.close();
  server.close();
}
