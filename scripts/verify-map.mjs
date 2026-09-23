/**
 * @file Verifies the map is actually drawing, not just that a canvas exists.
 *
 * The e2e suite proves the Cesium canvas element mounted; that is not the same
 * as the globe and its overlays having rendered. This reads the WebGL
 * framebuffer back and reports how many distinct colour buckets it contains, so
 * a blank black canvas fails while a real scene passes.
 *
 * Usage: node scripts/verify-map.mjs [baseUrl]
 *
 * @module signal-hub/scripts/verify-map
 */

import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'http://127.0.0.1:12001';

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1000 });

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Sign in and populate the city so every overlay has something to draw.
  await page.click('#sign-in');
  await page.waitForSelector('.login-form input[name="operator"]');
  await page.type('.login-form input[name="operator"]', 'control');
  await page.type('.login-form input[name="password"]', 'control');
  await page.click('.login-form button[type="submit"]');
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await page.evaluate(async () => {
    const token = localStorage.getItem('signal-hub.token');
    const auth = { authorization: `Bearer ${token}` };
    await fetch('/api/simulation/demo', { method: 'POST', headers: auth });
    await fetch('/api/simulation/start', { method: 'POST', headers: auth });
  });
  await new Promise((resolve) => setTimeout(resolve, 7000));

  // The framebuffer cannot be read back with readPixels: Cesium does not set
  // preserveDrawingBuffer, so once the frame is composited the buffer is
  // cleared. The composited screenshot is the honest source instead, and it is
  // analysed inside the page so the PNG can be decoded with the browser's own
  // image support.
  const shot = await page.screenshot({
    encoding: 'base64',
    clip: { x: 230, y: 62, width: 1030, height: 720 },
  });

  const report = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('screenshot failed to decode'));
      image.src = `data:image/png;base64,${dataUrl}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Set();
    let lit = 0;
    let sampled = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      sampled += 1;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      buckets.add(key);
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit += 1;
    }
    return { width: canvas.width, height: canvas.height, distinctBuckets: buckets.size, sampled, lit };
  }, shot);

  console.log('Map render report:', JSON.stringify(report));

  if (report.lit === 0) {
    console.error('FAIL  map region is black — nothing is being drawn');
    process.exitCode = 1;
  } else if (report.distinctBuckets < 8) {
    console.error(`FAIL  only ${report.distinctBuckets} distinct colour buckets — scene looks blank`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS  map is drawing: ${report.distinctBuckets} distinct colour buckets, ${report.lit}/${report.sampled} samples lit`,
    );
  }
} finally {
  await browser.close();
}
