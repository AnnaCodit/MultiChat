const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadFetcher(fetch) {
  const sandbox = {
    fetch,
    console: { log() {}, warn() {}, error() {} },
    Response
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/utils.js'), 'utf8');
  vm.runInContext(`${source}\nthis.fetchWithCorsProxy = fetchWithCorsProxy;`, sandbox);
  return sandbox.fetchWithCorsProxy;
}

test('own proxy is used first for a CORS-restricted target', async () => {
  const calls = [];
  const fetchWithCorsProxy = loadFetcher(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  });
  const init = { cache: 'no-store' };

  const response = await fetchWithCorsProxy('https://www.youtube.com/@channel/live', init);

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://fra3a.ru/tools/proxy/?url=https%3A%2F%2Fwww.youtube.com%2F%40channel%2Flive'
  );
  assert.equal(calls[0].init, init);
});

test('public proxies remain fallback when the own proxy fails', async () => {
  const calls = [];
  const fetchWithCorsProxy = loadFetcher(async url => {
    calls.push(url);
    if (url.startsWith('https://fra3a.ru/tools/proxy/')) {
      return { ok: false, status: 502 };
    }

    return { ok: true, status: 200 };
  });

  const response = await fetchWithCorsProxy('https://kick.com/api/v2/channels/test');

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/fra3a\.ru\/tools\/proxy\//);
  assert.match(calls[1], /^https:\/\/corsproxy\.io\//);
});

test('an aborted request does not continue through public fallbacks', async () => {
  const calls = [];
  const abortError = new Error('request aborted');
  const fetchWithCorsProxy = loadFetcher(async url => {
    calls.push(url);
    throw abortError;
  });

  await assert.rejects(
    fetchWithCorsProxy('https://www.youtube.com/live_chat?v=test', {
      signal: { aborted: true }
    }),
    error => error === abortError
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/fra3a\.ru\/tools\/proxy\//);
});
