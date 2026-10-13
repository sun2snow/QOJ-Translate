const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const core = require('../qoj-translate.user.js');

function documentOf(html) {
  return new JSDOM(`<main>${html}</main>`, { url: 'https://qoj.ac/contest/4113/problem/20245' }).window.document;
}
const config = { ...core.DEFAULTS, apiKey: 'test-only-not-a-real-key' };
const envelope = text => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

test('default config uses the exact user-supplied Responses endpoint and model', () => {
  assert.equal(core.checkConfig(config), config);
  assert.equal(config.endpoint, 'https://cpa.072899.xyz/v1/responses');
  assert.equal(config.model, 'gemini-3.8-flash-high');
  for (const endpoint of ['http://api.test/v1/responses', 'https://api.test/v1/chat/completions', 'https://user:pass@api.test/v1/responses']) {
    assert.throws(() => core.checkConfig({ ...config, endpoint }));
  }
  assert.throws(() => core.checkConfig({ ...config, apiKey: '' }));
});

test('raw TeX is masked, restored exactly and cannot be duplicated/reordered', () => {
  const source = 'Let $n$ be odd, \\(x^2\\), \\[a+b\\] and $$c$$.';
  const { masked, values } = core.maskMath(source);
  assert.equal(values.length, 4);
  assert.equal(core.unmaskMath(masked, values), source);
  assert.throws(() => core.unmaskMath(masked + '⟦QOJ_MATH_0⟧', values));
  assert.throws(() => core.unmaskMath(masked.replace('⟦QOJ_MATH_0⟧', '⟦QOJ_MATH_2⟧'), values));
  assert.equal(core.maskMath('Cost \\$5.').values.length, 0);
});

test('long fragments split losslessly without splitting formula tokens or emoji', () => {
  const source = 'abc'.repeat(1005) + '⟦QOJ_MATH_12345⟧' + '😀'.repeat(1000) + ' end';
  const parts = core.splitText(source, 3020);
  assert.equal(parts.join(''), source);
  assert.ok(parts.every(p => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)));
  assert.ok(parts.some(p => p.includes('⟦QOJ_MATH_12345⟧')));
});

test('HTML translation preserves node identities, listeners, inline markup, images, math and samples', () => {
  const doc = documentOf(`<article id="statement">
    <h2>Input</h2><p>Given <strong>an integer</strong> $n$, print <code>Joker</code>.</p>
    <p>For <mjx-container><span>x+1</span></mjx-container> and <span class="katex">x^2</span>, find the answer.</p>
    <img id="diagram" src="diagram.png"><svg><text>KEEP SVG</text></svg>
    <pre>1 2\nJoker</pre><div class="sample-output">Judger</div>
    <button>Copy</button><p hidden>Hidden prose</p><p aria-hidden="true">Hidden a11y</p>
    <script>window.secret = 'not sent';</script><p translate="no">KEEP ORIGINAL</p>
    <a href="/problem/7">Related problem</a>
  </article>`);
  const root = doc.querySelector('article');
  const original = root.innerHTML;
  const image = doc.querySelector('img');
  const link = doc.querySelector('a');
  let events = 0;
  link.addEventListener('custom-test', () => events++);
  const plan = core.collectHTML(root);
  const sent = plan.segments.map(s => s.text).join(' ');
  for (const excluded of ['Joker', 'Judger', 'x+1', 'x^2', 'KEEP SVG', 'Hidden', 'not sent', 'KEEP ORIGINAL']) {
    assert.ok(!sent.includes(excluded), excluded);
  }
  const payload = { translations: plan.segments.map(s => ({ id: s.id, text: '中文：' + s.text })) };
  const values = core.validateHTML(payload, plan.segments);
  const records = core.prepareHTML(plan, values);
  core.applyHTML(records, true);
  assert.equal(doc.querySelector('img'), image);
  assert.equal(doc.querySelector('a'), link);
  assert.equal(doc.querySelector('pre').textContent, '1 2\nJoker');
  assert.equal(doc.querySelector('code').textContent, 'Joker');
  assert.match(root.textContent, /\$n\$/);
  assert.match(root.textContent, /中文/);
  link.dispatchEvent(new doc.defaultView.Event('custom-test'));
  assert.equal(events, 1);
  core.applyHTML(records, false);
  assert.equal(root.innerHTML, original);
  core.applyHTML(records, true);
  core.applyHTML(records, false);
  assert.equal(root.innerHTML, original);
});

test('HTML validates IDs, empty values, placeholders, whitespace and hostile model HTML', () => {
  const segments = [{ id: 't0_0', text: ' Let ⟦QOJ_MATH_0⟧ be odd.\n', context: '' }];
  const valid = { translations: [{ id: 't0_0', text: '令 ⟦QOJ_MATH_0⟧ 为奇数。' }] };
  assert.equal(core.validateHTML(valid, segments).t0_0, ' 令 ⟦QOJ_MATH_0⟧ 为奇数。\n');
  assert.throws(() => core.validateHTML({ translations: [] }, segments));
  assert.throws(() => core.validateHTML({ translations: [{ id: 'wrong', text: 'x' }] }, segments));
  assert.throws(() => core.validateHTML({ translations: [{ id: 't0_0', text: '' }] }, segments));
  assert.throws(() => core.validateHTML({ translations: [{ id: 't0_0', text: 'discard math' }] }, segments));
  const doc = documentOf('<article>Hello world</article>');
  const plan = core.collectHTML(doc.querySelector('article'));
  const values = core.validateHTML({ translations: [{ id: 't0_0', text: '<img src=x onerror=alert(1)>' }] }, plan.segments);
  core.applyHTML(core.prepareHTML(plan, values), true);
  assert.equal(doc.querySelector('img'), null);
  assert.match(doc.querySelector('article').textContent, /onerror/);
});

test('changed DOM is rejected atomically, before the first text is changed', () => {
  const doc = documentOf('<article><p>First paragraph.</p><p>Second paragraph.</p></article>');
  const plan = core.collectHTML(doc.querySelector('article'));
  const records = core.prepareHTML(plan, { t0_0: '第一段。', t1_0: '第二段。' });
  records[1].node.nodeValue = 'Changed by the website';
  assert.throws(() => core.applyHTML(records, true), /变化/);
  assert.equal(records[0].node.nodeValue, 'First paragraph.');
});

test('batches account for context, do not lose or reorder fragments', () => {
  const segments = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, text: 'a'.repeat(100), context: 'b'.repeat(100) }));
  const batches = core.makeBatches(segments, 500);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), segments);
});

test('Responses JSON and complete SSE are supported, incomplete/refused/error results rejected', () => {
  assert.equal(core.parseAPIResponse(JSON.stringify(envelope('你好'))), '你好');
  assert.equal(core.parseAPIResponse('data: {"type":"response.output_text.delta","delta":"ignore"}\n\n' +
    'data: ' + JSON.stringify({ type: 'response.completed', response: envelope('完整回复') }) + '\n\ndata: [DONE]\n\n'), '完整回复');
  assert.throws(() => core.parseAPIResponse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
  assert.throws(() => core.responseText({ status: 'incomplete', output_text: 'partial' }));
  assert.throws(() => core.responseText({ status: 'in_progress', output_text: 'partial' }));
  assert.throws(() => core.responseText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }));
  assert.throws(() => core.parseAPIResponse('<html>Gateway error</html>'));
  assert.deepEqual(core.parseJSON('```json\n{"blocks":[]}\n```'), { blocks: [] });
});

test('detects UOJ/QOJ HTML without misclassifying a PDF download link', () => {
  const doc = documentOf('<section id="tab-statement"><article><h2>Input</h2><p>' + 'Problem statement. '.repeat(30) +
    '</p><a href="/download.php?type=statement&id=20245">Download</a></article></section>');
  const target = core.detectStatement(doc, doc.URL, config);
  assert.equal(target.kind, 'html');
  assert.equal(target.root.tagName, 'ARTICLE');
  assert.throws(() => core.detectStatement(doc, doc.URL, { ...config, selector: 'body' }));
  assert.throws(() => core.detectStatement(doc, doc.URL, { ...config, selector: '[' }));
});

test('detects direct and PDF.js-wrapped PDF URLs and rejects external PDF URLs', () => {
  const url = 'https://qoj.ac/contest/4576/problem/22881';
  const doc = documentOf('<div id="tab-statement"><article><iframe src="/pdfjs/web/viewer.html?file=%2Fdownload.php%3Fcontest_id%3D4576%26id%3D22881%26type%3Dstatement"></iframe></article></div>');
  const target = core.detectStatement(doc, url, config);
  assert.equal(target.kind, 'pdf');
  assert.equal(target.pdfURL, 'https://qoj.ac/download.php?contest_id=4576&id=22881&type=statement');
  assert.equal(core.pdfURLFrom('/a.pdf#page=2', url), 'https://qoj.ac/a.pdf');
  assert.equal(core.pdfURLFrom('https://evil.test/a.pdf', url), null);
  assert.throws(() => core.detectStatement(doc, url, { ...config, pdfURL: 'https://evil.test/a.pdf' }));
});

test('PDF blocks validate crop bounds and render hostile output only as text', () => {
  const blocks = core.validatePDF({ blocks: [
    { type: 'paragraph', text: '给定 \\(n\\)。' },
    { type: 'original', box: [50, 300, 900, 100] },
  ] }, true);
  assert.equal(blocks.length, 2);
  assert.throws(() => core.validatePDF({ blocks }, false));
  assert.throws(() => core.validatePDF({ blocks: [{ type: 'original', box: [0, 0, 2000, 50] }] }, true));
  assert.throws(() => core.validatePDF({ blocks: [{ type: 'script', text: 'alert(1)' }] }, true));
  const doc = documentOf('');
  const rendered = core.renderPDFBlock(doc, { type: 'paragraph', text: '<script>alert(1)</script>' });
  assert.equal(rendered.querySelector('script'), null);
  assert.equal(rendered.textContent, '<script>alert(1)</script>');
});

test('API request uses Responses input, bearer auth, no cookies, no redirects and store:false', async () => {
  let sent;
  global.GM_xmlhttpRequest = options => {
    sent = options;
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(envelope('{"ok":true}')), finalUrl: config.endpoint }));
    return { abort() {} };
  };
  const result = await core.callAPI(config, 'instructions', [{ type: 'input_text', text: 'problem' }], new AbortController().signal);
  assert.equal(result, '{"ok":true}');
  assert.equal(sent.anonymous, true);
  assert.equal(sent.redirect, 'error');
  assert.equal(sent.headers.Authorization, 'Bearer test-only-not-a-real-key');
  const payload = JSON.parse(sent.data);
  assert.equal(payload.model, config.model);
  assert.equal(payload.store, false);
  assert.equal(payload.stream, false);
  assert.equal(payload.instructions, 'instructions');
  assert.deepEqual(payload.input[0].content, [{ type: 'input_text', text: 'problem' }]);
  assert.equal(payload.messages, undefined);
});

test('HTTP errors do not echo proxy response bodies or API keys', async () => {
  global.GM_xmlhttpRequest = options => {
    queueMicrotask(() => options.onload({ status: 401, responseText: 'SECRET key leaked by proxy' }));
    return { abort() {} };
  };
  await assert.rejects(() => core.callAPI(config, 'x', [], new AbortController().signal), error => {
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
});

test('abort propagates to GM request and own timeout works even if TM ignores timeout', async () => {
  let aborts = 0;
  global.GM_xmlhttpRequest = () => ({ abort() { aborts++; } });
  const controller = new AbortController();
  const pending = core.request({ timeout: 10000 }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(aborts, 1);
  await assert.rejects(core.request({ timeout: 10 }, new AbortController().signal), /超时/);
  assert.equal(aborts, 2);
});

test('retry-after is bounded and exponential retry is available', () => {
  assert.equal(core.retryDelay('Retry-After: 120\r\n', 0), 60000);
  assert.equal(core.retryDelay('retry-after: 2\n', 0), 2000);
  assert.ok(core.retryDelay('', 1) >= 3000);
});
