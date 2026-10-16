// Renders index.html frame by frame and encodes media/intro-video/payi-intro.mp4.
// Usage: serve the repo root on :8765 (npx http-server -p 8765), then
//   node media/intro-video/render.mjs            full video
//   node media/intro-video/render.mjs 5 9.5 20   stills at those seconds (PNG)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.INTRO_URL || 'http://127.0.0.1:8765/media/intro-video/index.html?t=0';
const FPS = 30, DURATION = 30;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const stills = process.argv.slice(2).map(Number);
if (stills.length) {
  for (const t of stills) {
    await page.evaluate(t => window.render(t), t);
    await page.screenshot({ path: path.join(process.env.STILL_DIR || here, `still-${t}.png`) });
  }
} else {
  const out = path.join(here, 'payi-intro.mp4');
  const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < FPS * DURATION; i++) {
    await page.evaluate(t => window.render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
