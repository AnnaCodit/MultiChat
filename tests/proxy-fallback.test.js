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
    Response,
    URLSearchParams,
    AbortSignal,
    AbortController,
    setTimeout,
    clearTimeout
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

test('a chat route forwards refresh and a malformed success advances to a public fallback', async () => {
  const calls = [];
  const upstream = 'https://kick.com/api/v2/channels/test';
  const fetchWithCorsProxy = loadFetcher(async url => {
    calls.push(new URL(url));
    if (calls.length < 3) return new Response('<html>Temporarily unavailable</html>');
    return Response.json({ contents: '{"chatroom":{"id":123}}' });
  });

  const result = await fetchWithCorsProxy(upstream, {}, {
    operation: 'kick-room', refresh: true, readResponse: response => response.json()
  });
  assert.equal(result.chatroom.id, 123);
  assert.equal(calls[0].searchParams.get('url'), upstream);
  assert.equal(calls[0].searchParams.get('operation'), 'kick-room');
  assert.equal(calls[0].searchParams.get('refresh'), '1');
  assert.equal(calls[1].hostname, 'corsproxy.io');
  assert.equal(calls[2].pathname, '/get');
});

test('structured chat route errors retain the open request ID after all fallbacks fail', async () => {
  const fetchWithCorsProxy = loadFetcher(async url => url.includes('fra3a.ru')
    ? new Response('', { status: 404, headers: { 'X-Multichat-Error': 'upstream_not_found', 'X-Multichat-Request-Id': 'request-001' } })
    : new Response('', { status: 502 }));

  await assert.rejects(
    fetchWithCorsProxy('https://www.youtube.com/@channel/live', {}, { operation: 'youtube-live' }),
    error => error.cause.status === 404 && error.cause.proxyCode === 'upstream_not_found' && error.cause.requestId === 'request-001'
  );
});

test('a slow public fallback can still deliver after the next fallback starts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let finish;
  const fetchWithCorsProxy = loadFetcher(async (url, init) => {
    const { hostname } = new URL(url);
    calls.push({ hostname, signal: init.signal });
    if (hostname === 'fra3a.ru') return new Response('', { status: 502 });
    if (hostname === 'corsproxy.io') return new Promise(resolve => { finish = resolve; });
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });

  const attempt = fetchWithCorsProxy('https://www.youtube.com/@channel/live', {}, {
    operation: 'youtube-live', readResponse: response => response.text()
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(4000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].signal.aborted, false);
  finish(new Response('Valid live page'));
  assert.equal(await attempt, 'Valid live page');
  assert.equal(calls[2].signal.aborted, true);
});

test('YouTube tries a public reserve when the primary chat page has no cursor', async t => {
  const calls = [];
  const sandbox = { AbortController, setTimeout, clearTimeout };
  sandbox.fetchWithCorsProxy = loadFetcher(async url => {
    calls.push(new URL(url));
    const renderer = calls.length === 1
      ? { continuations: [{ unknownFormat: {} }] }
      : { continuations: [{ timedContinuationData: { continuation: 'valid-cursor' } }] };
    return new Response(`<script>var ytInitialData = ${JSON.stringify({ contents: { liveChatRenderer: renderer } })};</script>`);
  });
  const source = fs.readFileSync(path.join(projectRoot, 'js/connectors/youtube.js'), 'utf8');
  const YoutubeConnector = vm.runInNewContext(`${source}\nYoutubeConnector`, sandbox);
  const connector = new YoutubeConnector(() => {}, () => {});
  connector.channelOrVideo = 'https://youtu.be/abcdefghijk';
  connector.abortController = new AbortController();
  t.after(() => connector.disconnect());

  await connector.fetchChatStep('abcdefghijk', connector.connectionId);
  assert.equal(connector.continuationToken, 'valid-cursor');
  assert.equal(calls[0].hostname, 'fra3a.ru');
  assert.equal(calls[1].hostname, 'corsproxy.io');
});

test('proxy/index.php allows twitchtracker.com host suffix', () => {
  const phpContent = fs.readFileSync(path.join(projectRoot, 'proxy/index.php'), 'utf8');
  assert.match(phpContent, /'twitchtracker\.com'/);
});

