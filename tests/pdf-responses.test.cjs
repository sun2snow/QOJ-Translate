const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../qoj-translate.user.js');
const config = { ...core.DEFAULTS, apiKey: 'synthetic-private-key' };
const valid = { blocks: [{ type: 'paragraph', text: '计算 \\(\\frac{a}{b}\\) 的值。', box: null }] };
const envelope = text => ({ status: 'completed', usage: { output_tokens: 120 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const content = [{ type: 'input_text', text: JSON.stringify({ page: 1, extractedText: 'Compute a / b.' }) }, { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }];
const malformed = String.raw`{"blocks":[{"type":"formula","text":"\(x\)","box":null}]}`;

function mock(t, respond) {
  const previous = Object.fromEntries(['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest'].map(k => [k, global[k]]));
  const storage = {}, requests = [];
  global.GM_getValue = (key, fallback) => structuredClone(storage[key] ?? fallback);
  global.GM_setValue = (key, value) => { storage[key] = structuredClone(value); };
  global.GM_xmlhttpRequest = options => {
    const body = JSON.parse(options.data);
    requests.push(body);
    const answer = respond(body, requests.length);
    queueMicrotask(() => options.onload({ status: 200, finalUrl: config.endpoint, ...answer }));
    return { abort() {} };
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  });
  return { storage, requests };
}
const ok = (text = JSON.stringify(valid)) => ({ responseText: JSON.stringify(envelope(text)) });
const unsupported = format => ({ status: 400, responseText: JSON.stringify({ error: { code: 'unsupported_value', param: 'text.format.type', message: `${format} is not supported` } }) });

// These are deliberately malformed model responses, not a claim about the
// user's actual response: that raw response has not been provided.
test('balanced extraction accepts BOM, fences and prose while preserving quotes, braces and TeX', () => {
  const data = { blocks: [{ type: 'paragraph', text: '引号 " 与大括号 { }，\\(\\frac{a}{b}\\)。' }] };
  const json = JSON.stringify(data);
  assert.deepEqual(core.parseJSON('\ufeff Here is the translation:\n```json\n' + json + '\n```\nDone.'), data);
  assert.deepEqual(core.parseJSON(json), data);
  assert.deepEqual(core.parseJSON('\n```JSON\n' + json + '\n```'), data);
});

test('parser rejects multiple roots, incomplete outer objects and invalid escaping without repairing data', () => {
  assert.throws(() => core.parseJSON(malformed), { code: 'OUTPUT_JSON' });
  assert.throws(() => core.parseJSON('{"blocks":[' + JSON.stringify(valid.blocks[0])), { code: 'OUTPUT_UNCLOSED' });
  assert.throws(() => core.parseJSON('{"blocks":[]} {"blocks":[]}'), { code: 'OUTPUT_AMBIGUOUS' });
  assert.throws(() => core.parseJSON('[]'), { code: 'OUTPUT_SCHEMA' });
  assert.throws(() => core.parseJSON('null'), { code: 'OUTPUT_SCHEMA' });
  assert.throws(() => core.parseJSON('{"blocks":]}'), { code: 'OUTPUT_JSON' });
  assert.throws(() => core.parseJSON(JSON.stringify(valid) + '}'), { code: 'OUTPUT_JSON' });
  assert.throws(() => core.parseJSON('x'.repeat(2100) + JSON.stringify(valid)), { code: 'OUTPUT_JSON' });
});

test('PDF validation detects silently decoded LaTeX controls and invalid image geometry', () => {
  for (const command of [String.raw`\frac{a}{b}`, String.raw`\begin{matrix}`, String.raw`\theta`, String.raw`\right)`]) {
    const raw = '{"blocks":[{"type":"formula","text":"' + command + '","box":null}]}';
    const parsed = core.parseJSON(raw); // JSON itself is valid (\f, \b, \t, \r).
    assert.throws(() => core.validatePDF(parsed, true), { code: 'OUTPUT_CONTROL' });
  }
  assert.equal(core.validatePDF(valid, true)[0].text, valid.blocks[0].text);
  assert.doesNotThrow(() => core.validatePDF({ blocks: [{ type: 'verbatim', text: '1\t2\r\n3' }] }, false));
  assert.throws(() => core.validatePDF({ blocks: [{ type: 'original', text: null, box: [900, 0, 101, 200] }] }, true), { code: 'OUTPUT_COORDINATES' });
  assert.throws(() => core.validatePDF({ blocks: [{ type: 'paragraph', text: '正文', box: [0, 0, 100, 100] }] }, true), { code: 'OUTPUT_SCHEMA' });
});

test('PDF requests use a strict Responses schema and an explicit bounded output budget', async t => {
  const { requests } = mock(t, () => ok());
  const events = [];
  const result = await core.requestPDFPage(config, content, new AbortController().signal, undefined, e => events.push(e));
  assert.equal(result.blocks[0].text, valid.blocks[0].text);
  const body = requests[0];
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.max_output_tokens, 16384);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.properties.blocks.items.required, ['type', 'text', 'box']);
  assert.equal(body.response_format, undefined);
  assert.equal(events[0].stage, 'validated');
  assert.equal(events[0].outputText, undefined);
  assert.ok(!core.pdfSchema(false).properties.blocks.items.properties.type.enum.includes('original'));
  assert.match(body.instructions, /EVERY LaTeX backslash/);
  assert.ok(body.instructions.includes(String.raw`"text":"计算 \\(\\frac{a}{b}\\) 的值。"`));
});

test('only explicit unsupported-format errors permit schema -> JSON -> prompt downgrade, cached per endpoint/model', async t => {
  const { storage, requests } = mock(t, body => body.text ? unsupported(body.text.format.type) : ok('Result:\n' + JSON.stringify(valid)));
  const events = [];
  await core.requestPDFPage(config, content, new AbortController().signal, undefined, e => events.push(e));
  assert.deepEqual(requests.map(r => r.text?.format.type || 'prompt'), ['json_schema', 'json_object', 'prompt']);
  assert.equal(events.filter(e => e.code === 'FORMAT_UNSUPPORTED').length, 2);
  await core.requestPDFPage(config, content, new AbortController().signal);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].text, undefined);
  // Stale hints expire, and another model must not inherit this model's hints.
  for (const value of Object.values(storage['qoj-translator-format-v1'])) value.at = 0;
  await core.requestPDFPage(config, content, new AbortController().signal);
  assert.equal(requests[4].text.format.type, 'json_schema');
  await core.requestPDFPage({ ...config, model: 'another-model' }, content, new AbortController().signal);
  assert.equal(requests[7].text.format.type, 'json_schema');
});

test('unsupported detection rejects image errors, schema bugs and generic HTTP errors', () => {
  const check = (message, param, status = 400) => core.unsupportedFormat(status, JSON.stringify({ error: { message, param } }));
  assert.equal(check("Unknown parameter: 'text.format'."), true);
  assert.equal(check("Unknown parameter: 'text'."), true);
  assert.equal(check('This model does not support response_format of type json_schema.'), true);
  assert.equal(check("'json_schema' is not supported for this model"), true);
  assert.equal(check('Invalid schema for json_schema: additionalProperties is required'), false);
  assert.equal(check('Image input is not supported with json_schema', 'input'), false);
  assert.equal(check('This model does not support image input when using json_schema'), false);
  assert.equal(check('Bad request'), false);
  assert.equal(check('json_schema is not supported', undefined, 401), false);
  assert.equal(core.unsupportedFormat(400, '<html>json_schema is not supported</html>'), false);
});

test('generic HTTP 400 or an invalid schema is not retried as another format', async t => {
  const { requests } = mock(t, () => ({ status: 400, responseText: JSON.stringify({ error: {
    message: 'Invalid schema for json_schema: additionalProperties is required; SECRET', param: 'text.format',
  } }) }));
  await assert.rejects(core.requestPDFPage(config, content, new AbortController().signal), e => {
    assert.equal(e.code, 'HTTP_ERROR');
    assert.ok(!e.message.includes('SECRET'));
    return true;
  });
  assert.equal(requests.length, 1);
});

test('malformed LaTeX JSON gets one repair with original inputs retained, not a format downgrade', async t => {
  const { requests } = mock(t, (_, n) => n === 1 ? ok(malformed) : ok());
  const events = [], notices = [];
  const result = await core.requestPDFPage(config, content, new AbortController().signal, text => notices.push(text), e => events.push(e));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input[0].content.slice(0, 2), content);
  const repair = JSON.parse(requests[1].input[0].content[2].text);
  assert.equal(repair.task, 'repair_json');
  assert.equal(repair.previousOutput, malformed);
  assert.ok(requests.every(r => r.text.format.type === 'json_schema'));
  assert.ok(notices.some(n => n.includes('额外计费')));
  assert.equal(events[0].code, 'OUTPUT_JSON');
  assert.equal(events[0].outputText, malformed);
  assert.equal(events[0].httpStatus, 200);
  assert.equal(events[1].attempt, 'repair');
  assert.equal(result.blocks[0].text, valid.blocks[0].text);
});

test('repeated malformed responses stop after two calls and can be diagnosed', async t => {
  const { requests } = mock(t, () => ok(malformed));
  const events = [];
  await assert.rejects(core.requestPDFPage(config, content, new AbortController().signal, undefined, e => events.push(e)), { code: 'OUTPUT_JSON' });
  assert.equal(requests.length, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].attempt, 'repair');
});

test('disabling automatic repair makes malformed responses fail after one call', async t => {
  const { requests } = mock(t, () => ok(malformed));
  await assert.rejects(core.requestPDFPage({ ...config, pdfAutoRepair: false }, content, new AbortController().signal), { code: 'OUTPUT_JSON' });
  assert.equal(requests.length, 1);
});

test('incomplete, unclosed, refused and filtered replies never trigger format repair or budget increases', async t => {
  let current;
  const { requests } = mock(t, () => ({ responseText: JSON.stringify(current) }));
  const cases = [
    [{ ...envelope(JSON.stringify(valid)), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'OUTPUT_TRUNCATED'],
    [envelope('{"blocks":['), 'OUTPUT_UNCLOSED'],
    [{ ...envelope(JSON.stringify(valid)), status: 'weird-status' }, 'API_NOT_COMPLETED'],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }, 'API_REFUSAL'],
    [{ ...envelope('partial'), status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'API_FILTERED'],
  ];
  for (const [body, code] of cases) {
    current = body;
    const n = requests.length;
    await assert.rejects(core.requestPDFPage(config, content, new AbortController().signal), { code });
    assert.equal(requests.length, n + 1);
    assert.equal(requests.at(-1).max_output_tokens, 16384);
  }
});

test('SSE incomplete events preserve useful diagnostics but never become successful output', () => {
  const raw = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n' +
    'data: ' + JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }) + '\n\n';
  assert.throws(() => core.parseAPIResponse(raw), e => {
    assert.equal(e.code, 'OUTPUT_TRUNCATED');
    assert.equal(e.details.incompleteReason, 'max_output_tokens');
    assert.equal(e.details.outputText, 'partial');
    return true;
  });
  assert.throws(() => core.parseAPIResponse('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'), { code: 'API_STREAM_INCOMPLETE' });
});

test('cancel during repair notification prevents the second charged request', async t => {
  const { requests } = mock(t, () => ok(malformed));
  const controller = new AbortController();
  await assert.rejects(core.requestPDFPage(config, content, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('diagnostics whitelist fields, redact secrets/images, strip URL query strings and stay bounded', () => {
  const c = { ...config, endpoint: config.endpoint + '?token=private-query' };
  const report = core.createPDFDiagnostic(c, 'https://qoj.ac/problem/7?session=private-query#secret');
  const text = `Key ${config.apiKey}\nAuthorization: Bearer other-secret\nCookie: session=other-cookie\n${content[1].image_url}`;
  for (let i = 0; i < 15; i++) core.recordPDFDiagnostic(report, {
    stage: 'parse', attempt: 'initial', outputText: text, code: 'OUTPUT_JSON', apiKey: config.apiKey,
    headers: { Authorization: config.apiKey }, input: content,
  }, c);
  const serialized = JSON.stringify(report);
  for (const secret of [config.apiKey, 'other-secret', 'other-cookie', 'private-query', 'base64,AAAA', '"headers"', '"apiKey"']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.equal(report.events.length, 12);
  assert.equal(report.events[0].code, 'OUTPUT_JSON');
  assert.ok(report.events[0].outputText.includes('[REDACTED]'));
});

test('forced refresh invalidates all selected pages, not unrelated caches', t => {
  const { storage } = mock(t, () => ok());
  storage['qoj-translator-cache-v3'] = { page1: { value: 'old1' }, page2: { value: 'old2' }, another: { value: 'keep' } };
  core.removeCacheKeys(['page1', 'page2']);
  assert.deepEqual(storage['qoj-translator-cache-v3'], { another: { value: 'keep' } });
  global.GM_setValue = () => { throw new Error('quota'); };
  assert.throws(() => core.removeCacheKeys(['another']), { code: 'CACHE_RESET_FAILED' });
});
