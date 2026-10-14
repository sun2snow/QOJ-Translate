const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
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
const multiPDFBytes = readFileSync(path.join(__dirname, 'fixtures/multipage.pdf'));
const fixtureHeader = `<meta charset="utf-8"><style>
  body{font:15px/1.6 Arial,sans-serif;color:#253247;margin:16px;background:#fff}
  .container{max-width:1000px;margin:30px auto}h1{font-size:26px;margin:0 0 6px}.meta{color:#8992a2;font-size:13px;margin-bottom:24px}
  article h2{font-size:19px}article pre{padding:16px;background:#f5f7fa;border-radius:6px}
  iframe{width:100%;height:460px;border:1px solid #ddd}
</style>`;
const fixtureTitle = '<h1 class="fixture-title">J. Synthetic Statement</h1><div class="meta">Time limit: 1 second · Memory limit: 512 MB · Local test fixture</div>';
const fixtures = {
  html: `<!doctype html>${fixtureHeader}<div class="container">${fixtureTitle}<div id="tab-statement"><article>
  <h2>Input</h2><p>Given an integer $n$, print <code>Joker</code> or <code>Judger</code>.</p>
  <p>The answer is <strong>strictly greater</strong> than the limit.</p>
  <p>Compute <mjx-container>n + 1</mjx-container> and return the answer.</p>
  <pre>2\n3 10\nJoker</pre><img id="original-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3C/svg%3E">
  </article></div><button id="submit">Submit</button></div>`,
  pdf: `<!doctype html>${fixtureHeader}<div class="container">${fixtureTitle}<div id="tab-statement"><article style="display: block !important"><iframe src="/download.php?contest_id=4576&id=22881&type=statement" title="PDF"></iframe></article></div></div>`,
};

async function setup(t, kind, { multi = false } = {}) {
  const fixturePDF = multi ? multiPDFBytes : pdfBytes;
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'qoj.ac' && url.pathname.includes('/problem/')) return route.fulfill({ body: fixtures[kind], contentType: 'text/html' });
    if (url.hostname === 'qoj.ac' && url.pathname === '/download.php') return route.fulfill({ body: fixturePDF, contentType: 'application/pdf' });
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
    window.__responses = [];
    window.__generation = 1;
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
        const injected = window.__responses.shift();
        if (injected) {
          const responseBody = injected.body || { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: injected.text }] }] };
          options.onload({ status: injected.status || 200, finalUrl: options.url, responseText: JSON.stringify(responseBody) });
          return;
        }
        const data = input.segments ? {
          translations: input.segments.map(s => ({ id: s.id, text: '中文：' + s.text })),
        } : {
          blocks: [
            { type: 'heading', text: `子集和（合成测试题）第 ${input.page} 页 v${window.__generation}` },
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
  }, { resource, pdfBase64: fixturePDF.toString('base64') });
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
  assert.equal(await toolbar.locator('.status-detail').isVisible(), true);
  assert.ok((await toolbar.boundingBox()).y + (await toolbar.boundingBox()).height <= (await page.locator('article').boundingBox()).y);
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
  assert.equal(await toolbar.isVisible(), true);
  assert.ok((await toolbar.boundingBox()).y + (await toolbar.boundingBox()).height <= (await reader.boundingBox()).y);
  assert.equal(await reader.evaluate(el => el.previousElementSibling?.dataset.qojTranslator), 'toolbar');
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

test('Chrome: inline toolbar sits below metadata, never covers text, and scrolls with the page', options, async t => {
  const { page, toolbar, errors } = await setup(t, 'html');
  const bar = await toolbar.boundingBox();
  const metadata = await page.locator('.meta').boundingBox();
  const statement = await page.locator('article').boundingBox();
  assert.ok(bar.y >= metadata.y + metadata.height);
  assert.ok(bar.y + bar.height <= statement.y);
  assert.ok(bar.height <= 60, `Desktop bar should stay compact: ${bar.height}`);
  assert.equal(await toolbar.evaluate(el => getComputedStyle(el).position), 'static');
  assert.equal(await page.locator('article').evaluate(el => el.previousElementSibling?.dataset.qojTranslator), 'toolbar');
  assert.equal(await toolbar.getByRole('button', { name: '查看原文' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await toolbar.getByRole('button', { name: '查看中文' }).isDisabled(), true);
  assert.equal(await toolbar.locator('dialog').isVisible(), false);
  if (process.env.UI_SCREENSHOTS) {
    mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'test-results/ui-desktop.png'), fullPage: true });
  }
  await page.evaluate(() => { document.body.style.minHeight = '2200px'; window.scrollTo(0, 500); });
  assert.ok((await toolbar.boundingBox()).y < 0, 'Toolbar must not stick to the viewport');
  assert.deepEqual(errors, []);
});

test('Chrome: toolbar and settings fit narrow screens without horizontal overflow', options, async t => {
  const { page, toolbar, errors } = await setup(t, 'html');
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    const bar = await toolbar.boundingBox();
    const article = await page.locator('article').boundingBox();
    assert.ok(bar.x >= 0 && bar.x + bar.width <= width, `Toolbar outside ${width}px viewport`);
    assert.ok(bar.y + bar.height <= article.y);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const name of ['查看原文', '查看中文', '翻译为中文', '设置', '更多操作']) {
      const box = await toolbar.getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(box.x >= bar.x && box.x + box.width <= bar.x + bar.width + 1, `${name} overflows at ${width}px`);
    }
    await toolbar.getByRole('button', { name: '设置', exact: true }).click();
    const modal = await toolbar.locator('dialog').boundingBox();
    assert.ok(modal.x >= 0 && modal.x + modal.width <= width);
    assert.ok(modal.y >= 0 && modal.y + modal.height <= 720);
    await page.keyboard.press('Escape');
  }
  if (process.env.UI_SCREENSHOTS) {
    await page.setViewportSize({ width: 375, height: 812 });
    mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'test-results/ui-mobile.png'), fullPage: true });
  }
  assert.deepEqual(errors, []);
});

test('Chrome: settings dialog validates visibly, restores focus, and discards unsaved drafts', options, async t => {
  const { page, toolbar, errors } = await setup(t, 'html');
  const settings = toolbar.getByRole('button', { name: '设置', exact: true });
  await settings.click();
  const modal = toolbar.getByRole('dialog', { name: '翻译设置' });
  assert.equal(await modal.isVisible(), true);
  await toolbar.locator('input[name="apiKey"]').fill('');
  await toolbar.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.match(await toolbar.locator('.form-error').textContent(), /API Key/);
  assert.equal(await toolbar.locator('.form-error').isVisible(), true);
  assert.equal(await modal.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await modal.isVisible(), false);
  assert.equal(await settings.evaluate(el => el.getRootNode().activeElement === el), true);
  await settings.click();
  assert.equal(await toolbar.locator('input[name="apiKey"]').inputValue(), 'synthetic-test-key');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await toolbar.evaluate(el => !!el.shadowRoot.activeElement?.closest('dialog')), true);
  }
  if (process.env.UI_SCREENSHOTS) {
    mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'test-results/ui-settings.png') });
  }
  await toolbar.getByRole('button', { name: '关闭设置', exact: true }).click();
  assert.equal(await modal.isVisible(), false);
  await settings.click();
  await page.mouse.click(2, 2);
  assert.equal(await modal.isVisible(), false);
  assert.equal(await page.evaluate(() => window.__requests.length), 0);
  assert.deepEqual(errors, []);
});

test('Chrome: more actions stay in flow; retranslation confirms charges and uses original text', options, async t => {
  const { page, toolbar, completed, errors, install } = await setup(t, 'html');
  const more = toolbar.getByRole('button', { name: '更多操作', exact: true });
  await more.click();
  assert.equal(await toolbar.getByRole('button', { name: '重新翻译', exact: true }).isDisabled(), true);
  const expanded = await toolbar.boundingBox();
  assert.ok(expanded.y + expanded.height <= (await page.locator('article').boundingBox()).y);
  await page.keyboard.press('Escape');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.equal(await toolbar.getByRole('button', { name: '查看中文' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).isVisible(), false);
  await toolbar.getByRole('button', { name: '查看中文' }).click();
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  await more.click();
  page.once('dialog', dialog => dialog.dismiss());
  await toolbar.getByRole('button', { name: '重新翻译', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  await more.click();
  page.once('dialog', dialog => dialog.accept());
  await toolbar.getByRole('button', { name: '重新翻译', exact: true }).click();
  await completed();
  assert.equal(await page.evaluate(() => window.__requests.length), 2);
  const sent = await page.evaluate(() => JSON.parse(window.__requests[1].input[0].content[0].text).segments);
  assert.ok(sent.every(s => !s.text.includes('中文：')));
  await more.click();
  await toolbar.getByRole('button', { name: '清除译文缓存', exact: true }).click();
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => window.__requests.length), 2);
  await page.reload();
  await install();
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  assert.deepEqual(errors, []);
});

test('Chrome: toolbar remounts after delayed statements and supports custom ancestor selectors', options, async t => {
  const { page, toolbar, completed, errors } = await setup(t, 'html');
  await page.evaluate(() => document.querySelector('#tab-statement').remove());
  await toolbar.waitFor({ state: 'visible' });
  assert.equal(await toolbar.getByRole('button', { name: '设置', exact: true }).isVisible(), true);
  await page.evaluate(() => {
    const tab = document.createElement('section');
    tab.id = 'tab-statement';
    const article = document.createElement('article');
    article.textContent = 'This is a delayed synthetic statement with enough text to detect.';
    tab.append(article);
    document.querySelector('.container').append(tab);
  });
  await page.waitForFunction(() => document.querySelector('article').previousElementSibling?.dataset.qojTranslator === 'toolbar');
  await toolbar.getByRole('button', { name: '设置', exact: true }).click();
  await toolbar.locator('summary').click();
  await toolbar.locator('input[name="selector"]').fill('#tab-statement');
  await toolbar.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#tab-statement').previousElementSibling?.dataset.qojTranslator === 'toolbar');
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.equal(await page.locator('[data-qoj-translator="toolbar"]').count(), 1);
  assert.match(await page.locator('article').textContent(), /中文/);
  assert.deepEqual(errors, []);
});

test('Chrome: failed PDF page keeps original visible, exports redacted diagnostics, and resumes after reload', options, async t => {
  const { page, toolbar, completed, errors, install } = await setup(t, 'pdf', { multi: true });
  const before = await page.locator('#tab-statement > article').innerHTML();
  await page.evaluate(() => {
    const bad = String.raw`{"blocks":[{"type":"formula","text":"synthetic-test-key \(x\)","box":null}]}`;
    window.__responses = [null, { text: bad }, { text: bad }];
  });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: '已校验完成 1 页' }).waitFor();
  assert.match(await toolbar.locator('.status').textContent(), /第 2\/3 页/);
  assert.equal(await page.locator('#tab-statement > article').isVisible(), true);
  assert.equal(await page.locator('#tab-statement > article').innerHTML(), before);
  assert.equal(await page.locator('[data-qoj-translator="pdf"]').count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: '继续未完成页', exact: true }).isEnabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__requests.map(r => JSON.parse(r.input[0].content[0].text).page)), [1, 2, 2]);
  assert.equal(await page.evaluate(() => Object.keys(GM_getValue('qoj-translator-cache-v3', {})).length), 1);
  await toolbar.getByRole('button', { name: '更多操作', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  const downloaded = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: '导出 PDF 诊断', exact: true }).click();
  const download = await downloaded;
  const raw = readFileSync(await download.path(), 'utf8');
  const diagnostic = JSON.parse(raw);
  assert.equal(diagnostic.currentPage, 2);
  assert.equal(diagnostic.status, 'failed');
  assert.equal(diagnostic.errorCode, 'OUTPUT_JSON');
  assert.deepEqual(diagnostic.completedPages, [1]);
  assert.equal(diagnostic.events.at(-1).attempt, 'repair');
  assert.ok(diagnostic.events.at(-1).outputText.includes('[REDACTED]'));
  assert.ok(!raw.includes('synthetic-test-key'));
  assert.ok(!raw.includes('data:image/'));
  // Durable page caching, not just a happy-path in-memory retry.
  await page.reload();
  await install();
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  assert.deepEqual(await page.evaluate(() => window.__requests.map(r => JSON.parse(r.input[0].content[0].text).page)), [2, 3]);
  assert.equal(await page.locator('[data-qoj-translator="pdf"]').locator('article').count(), 3);
  assert.deepEqual(errors, []);
});

test('Chrome: forced PDF refresh invalidates old pages before a failure and resume never mixes generations', options, async t => {
  const { page, toolbar, completed, errors } = await setup(t, 'pdf', { multi: true });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await completed();
  await page.evaluate(() => {
    window.__generation = 2;
    window.__responses = [null, { text: 'Not JSON' }, { text: 'Still not JSON' }];
  });
  await toolbar.getByRole('button', { name: '更多操作', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await toolbar.getByRole('button', { name: '重新翻译', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: '已校验完成 1 页' }).waitFor();
  assert.equal(await page.evaluate(() => Object.keys(GM_getValue('qoj-translator-cache-v3', {})).length), 1);
  await toolbar.getByRole('button', { name: '继续未完成页', exact: true }).click();
  await completed();
  assert.deepEqual(await page.evaluate(() => window.__requests.map(r => JSON.parse(r.input[0].content[0].text).page)), [1, 2, 3, 1, 2, 2, 2, 3]);
  const headings = await page.locator('[data-qoj-translator="pdf"]').locator('article h3').allTextContents();
  assert.equal(headings.length, 3);
  assert.ok(headings.every(text => text.includes('v2')));
  assert.deepEqual(errors, []);
});

test('Chrome: truncation requires manual budget change and never applies partial or auto-repaired output', options, async t => {
  const { page, toolbar, completed, errors } = await setup(t, 'pdf');
  await page.evaluate(() => {
    window.__responses = [{ body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"blocks":[' } }];
  });
  await toolbar.getByRole('button', { name: '翻译为中文', exact: true }).click();
  await toolbar.locator('.status').filter({ hasText: 'API 回复被截断' }).waitFor();
  assert.equal(await page.evaluate(() => window.__requests.length), 1);
  assert.equal(await page.locator('#tab-statement > article').isVisible(), true);
  assert.equal(await page.locator('[data-qoj-translator="pdf"]').count(), 0);
  await toolbar.getByRole('button', { name: '设置', exact: true }).click();
  await toolbar.locator('input[name="pdfOutputTokens"]').fill('32768');
  await toolbar.getByRole('button', { name: '保存设置', exact: true }).click();
  await toolbar.getByRole('button', { name: '继续未完成页', exact: true }).click();
  await completed();
  assert.deepEqual(await page.evaluate(() => window.__requests.map(r => r.max_output_tokens)), [16384, 32768]);
  assert.deepEqual(errors, []);
});
