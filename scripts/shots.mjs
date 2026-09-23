import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1000 });
await page.goto('http://127.0.0.1:12001', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));

// sign in and run the demo so the map has content
await page.click('#sign-in');
await page.waitForSelector('.login-form input[name="operator"]');
await page.type('.login-form input[name="operator"]', 'control');
await page.type('.login-form input[name="password"]', 'control');
await page.click('.login-form button[type="submit"]');
await new Promise((r) => setTimeout(r, 2500));

await page.evaluate(async () => {
  const token = localStorage.getItem('signal-hub.token');
  await fetch('/api/simulation/demo', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await fetch('/api/simulation/start', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
});
await new Promise((r) => setTimeout(r, 7000));

await page.screenshot({ path: '/tmp/shot-demo.png' });

// overview
await page.evaluate(() => document.querySelector('.nav-item[data-mode="overview"]')?.click());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/shot-overview.png' });

// simulation page
await page.evaluate(() => document.querySelector('.nav-item[data-mode="simulation"]')?.click());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/shot-simulation.png' });

// violations page
await page.evaluate(() => document.querySelector('.nav-item[data-mode="violations"]')?.click());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/shot-violations.png' });

const state = await page.evaluate(() => ({
  metrics: document.querySelectorAll('.metric').length,
  rows: document.querySelectorAll('.data-table tr').length,
  timeline: document.querySelectorAll('.timeline-item').length,
  alerts: document.querySelector('#alert-host')?.textContent || '',
}));
console.log(JSON.stringify(state));
await browser.close();
