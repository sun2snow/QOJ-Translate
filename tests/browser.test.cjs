const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const script = readFileSync(path.join(ROOT, 'qoj-translate.user.js'), 'utf8');
const resource = {
  pdfjsModule: readFileSync(path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.min.mjs'), 'utf8'),
  pdfjsWorker: readFileSync(path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8'),
  katexCSS: readFileSync(path.join(ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
};
const pdfBytes = readFileSync(path.join(__dirname, 'fixtures/statement.pdf'));
const pdfBase64 = pdfBytes.toString('base64');
const fixtures = {
  html: `<!doctype html><meta charset="utf-8"><div class="container"><div id="tab-statement"><article>
  <h2>Input</h2><p>Given an integer $n$, print <code>Joker</code> or <code>Judger</code>.</p>
  <p>The answer is <strong>strictly greater</strong> than the limit.</p>
  <p>Compute <mjx-container>n + 1</mjx-container> and return the answer.</p>
  <pre>2\n3 10\nJoker</pre><img id="original-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3C/svg%3E">
  </article></div><button id="submit">Submit</button></div>`,
  pdf: '<!doctype html><meta charset="utf-8"><div id="tab-statement"><article style="display: block !important"><iframe src="/download.php?contest_id=4576&id=22881&type=statement" title="PDF"></iframe></article></div>',
};

async function setup(t, kind) {
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'qoj.ac' && url.pathname.includes('/problem/')) return route.fulfill({ body: fixtures[kind], contentType: 'text/html' });
    if (url.hostname === 'qoj.ac' && url.pathname === '/download.php') return route.fulfill({ body: pdfBytes, contentType: 'application/pdf' });
    // Tests never contact QOJ, the configured proxy or a CDN.
    return route.abort();
  });
  await page.addInitScript(({ resource, pdfBase64 }) => {
    // Test-only instrumentation: let Playwright inspect the otherwise closed Shadow DOM.
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return attach.call(this, { ...init, mode: 'open' }); };
    window.GM_getValue = (key, fallback) => {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    };
    window.GM_setValue = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    window.GM_getResourceText = name => resource[name];
    window.__requests = [];
    window.__mode = 'success';
    window.__aborts = 0;
    window.GM_xmlhttpRequest = options => {
      let aborted = false;
      const timer = setTimeout(() => {
        if (aborted) return;
        if (options.method === 'GET') {
          const binary = atob(pdfBase64);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          options.onload({ status: 200, response: bytes.buffer, finalUrl: options.url });
          return;
        }
        if (window.__mode === 'hang') return;
        if (window.__mode === 'http-error') { options.onload({ status: 400, responseText: '{"error":"synthetic"}' }); return; }
        const body = JSON.parse(options.data);
        window.__requests.push(body);
        const input = JSON.parse(body.input[0].content[0].text);
        const data = input.segments ? {
          translations: input.segments.map(s => ({ id: s.id, text: '中文：' + s.text })),
        } : {
          blocks: [
            { type: 'heading', text: '子集和（合成测试题）' },
            { type: 'paragraph', text: '给定整数 \\(n\\)，计算所有数值的和。输出字符串 Joker。' },
            ...(input.imageProvided ? [{ type: 'original', box: [90, 330, 820, 180] }] : [{ type: 'verbatim', text: '3 10\nJoker' }]),
          ],
        };
        options.onload({ status: 200, finalUrl: options.url, responseText: JSON.stringify({
          status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
        }) });
      }, 5);
      return { abort() { aborted = true; clearTimeout(timer); window.__aborts++; options.onabort?.(); } };
    };
  }, { resource, pdfBase64 });
  const url = kind === 'html' ? 'https://qoj.ac/contest/4113/problem/20245' : 'https://qoj.ac/contest/4576/problem/22881';
  await page.goto(url);
  async function install() {
    await page.addScriptTag({ path: path.join(ROOT, 'node_modules/katex/dist/katex.min.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'node_modules/katex/dist/contrib/auto-render.min.js') });
    await page.addScriptTag({ content: script });
  }
  await install();
  const toolbar = page.locator('[data-qoj-translator="toolbar"]');
  await toolbar.getByRole('button', { name: '设置', exact: true }).click();
  await toolbar.locator('input[name="apiKey"]').fill('synthetic-test-key');
  await toolbar.getByRole('button', { name: '保存设置', exact: true }).click();
  const completed = () => toolbar.locator('.status').filter({ hasText: '中文题面已显示' }).waitFor({ timeout: 30000 });
  return { page, toolbar, completed, errors, install };
}
const options = { skip: !existsSync(chrome), timeout: 60000 };

test('Chrome: HTML end-to-end translation, exact restore, local cache, no sample or image changes', options, async t => {
  const { page, toolbar, completed, errors, install } = await setup(t, 'html');
  const before = await page.locator('article').innerHTML();
  await page.evaluate(() => { window.__originalImage = document.querySelector('#original-image'); });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.match(await page.locator('article').textContent(), /中文/);
  assert.equal(await page.locator('pre').textContent(), '2\n3 10\nJoker');
  assert.equal(await page.locator('#submit').textContent(), 'Submit');
  assert.equal(await page.evaluate(() => document.querySelector('#original-image') === window.__originalImage), true);
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  await toolbar.getByRole('button', { name: '查看原文', exact: true }).click();
  assert.equal(await page.locator('article').innerHTML(), before);
  await toolbar.getByRole('button', { name: '查看中文', exact: true }).click();
  assert.match(await page.locator('article').textContent(), /中文/);
  // A new page instance must use the cached output without another API request.
  await page.reload();
  await install();
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.equal(await page.evaluate(() => window.__requests.length), 0);
  assert.deepEqual(errors, []);
});

test('Chrome: API failure and cancellation leave original HTML intact', options, async t => {
  const { page, toolbar, errors } = await setup(t, 'html');
  const before = await page.locator('article').innerHTML();
  await page.evaluate(() => { window.__mode = 'http-error'; });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: 'HTTP 400' }).waitFor();
  assert.equal(await page.locator('article').innerHTML(), before);
  await page.evaluate(() => { window.__mode = 'hang'; });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: 'HTML 翻译中' }).waitFor();
  await toolbar.getByRole('button', { name: '取消', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: '已取消' }).waitFor();
  assert.equal(await page.locator('article').innerHTML(), before);
  assert.equal(await page.evaluate(() => window.__aborts), 1);
  assert.deepEqual(errors, []);
});

test('Chrome: real PDF.js ESM renders a PDF, crops originals, typesets math and restores native viewer', options, async t => {
  const { page, toolbar, completed, errors, install } = await setup(t, 'pdf');
  const original = page.locator('#tab-statement > article');
  const before = await original.evaluate(el => [el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')]);
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  try { await completed(); } catch (error) {
    throw new Error(`${error.message}\nUI: ${await toolbar.locator('.status').textContent()}\nErrors: ${errors.join('; ')}`);
  }
  const reader = page.locator('[data-qoj-translator="pdf"]');
  assert.equal(await reader.locator('figure img').count(), 1);
  assert.equal(await reader.locator('details img').count(), 1);
  assert.equal(await reader.locator('.katex').count(), 1);
  assert.ok(await reader.locator('figure img').evaluate(img => img.naturalWidth > 100));
  assert.equal(await original.evaluate(el => getComputedStyle(el).display), 'none');
  const requests = await page.evaluate(() => window.__requests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input[0].content[1].type, 'input_image');
  assert.match(JSON.parse(requests[0].input[0].content[0].text).extractedText, /Given an integer n/);
  assert.match(requests[0].input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  await toolbar.getByRole('button', { name: '查看原文', exact: true }).click();
  assert.deepEqual(await original.evaluate(el => [el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')]), before);
  assert.equal(await reader.isVisible(), false);
  await toolbar.getByRole('button', { name: '查看中文', exact: true }).click();
  assert.equal(await reader.isVisible(), true);
  await page.reload();
  await install();
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.equal(await page.evaluate(() => window.__requests.length), 0);
  assert.deepEqual(errors, []);
});

test('Chrome: text-only PDF mode sends no image and expands full original page', options, async t => {
  const { page, toolbar, completed, errors } = await setup(t, 'pdf');
  await toolbar.getByRole('button', { name: '设置', exact: true }).click();
  await toolbar.locator('input[name="pdfImages"]').uncheck();
  await toolbar.getByRole('button', { name: '保存设置', exact: true }).click();
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  const reader = page.locator('[data-qoj-translator="pdf"]');
  assert.equal(await reader.locator('details').getAttribute('open'), '');
  assert.equal(await reader.locator('pre').textContent(), '3 10\nJoker');
  assert.equal(await page.evaluate(() => window.__requests[0].input[0].content.length), 1);
  assert.deepEqual(errors, []);
});
