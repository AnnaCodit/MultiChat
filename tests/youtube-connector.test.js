const test = require('node:test');
const assert = require('node:assert/strict');
const YoutubeConnector = require('../js/connectors/youtube.js');
const initialFixture = require('./fixtures/youtube-initial-data.json');
const continuationFixture = require('./fixtures/youtube-continuation-data.json');

function page(data, variable = 'ytInitialData') {
  return new Response(`<script>var ${variable} = ${JSON.stringify(data)};</script>`);
}

function createConnector() {
  const messages = [];
  const statuses = [];
  const connector = new YoutubeConnector(
    message => messages.push(message),
    (platform, active, description) => statuses.push({ platform, active, description }),
    {
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      setTimer: () => 1,
      clearTimer() {}
    }
  );

  return { connector, messages, statuses };
}

test('extractVideoId supports common YouTube URL formats and rejects foreign hosts', () => {
  const { connector } = createConnector();

  assert.equal(connector.extractVideoId('gCNeDWCI0vo'), 'gCNeDWCI0vo');
  assert.equal(
    connector.extractVideoId('https://www.youtube.com/watch?feature=share&v=gCNeDWCI0vo'),
    'gCNeDWCI0vo'
  );
  assert.equal(connector.extractVideoId('https://youtu.be/gCNeDWCI0vo?t=2'), 'gCNeDWCI0vo');
  assert.equal(connector.extractVideoId('https://youtube.com/live/gCNeDWCI0vo'), 'gCNeDWCI0vo');
  assert.equal(connector.extractVideoId('https://youtube.com/shorts/gCNeDWCI0vo'), 'gCNeDWCI0vo');
  assert.equal(connector.extractVideoId('https://example.com/watch?v=gCNeDWCI0vo'), null);
});

test('channel URLs and IDs are normalized to their live endpoint', () => {
  const { connector } = createConnector();

  assert.equal(
    connector.buildChannelLiveUrl('@AlJazeeraEnglish'),
    'https://www.youtube.com/@AlJazeeraEnglish/live'
  );
  assert.equal(
    connector.buildChannelLiveUrl('https://youtube.com/@AlJazeeraEnglish/videos'),
    'https://www.youtube.com/@AlJazeeraEnglish/live'
  );
  assert.equal(
    connector.buildChannelLiveUrl('https://youtube.com/@AlJazeeraEnglish'),
    'https://www.youtube.com/@AlJazeeraEnglish/live'
  );
  assert.equal(
    connector.buildChannelLiveUrl('UCNye-wNBqNL5ZzHSJj3l8Bg'),
    'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live'
  );
});

test('balanced ytInitialData extraction is not confused by braces inside strings', () => {
  const { connector } = createConnector();
  const expected = {
    contents: {
      liveChatRenderer: {
        value: 'text with }; and escaped " quote'
      }
    }
  };
  const html = `<script>window["ytInitialData"] = ${JSON.stringify(expected)};</script>`;

  assert.deepEqual(connector.extractYtInitialData(html), expected);
});

test('initial live chat data parses text, paid events, memberships, stickers and emoji', () => {
  const { connector, messages } = createConnector();
  const result = connector.parseYtLiveChatData(initialFixture);

  assert.equal(result.messageCount, 4);
  assert.equal(result.timeoutMs, 1000);
  assert.equal(result.ended, false);
  assert.equal(connector.continuationToken, 'live-chat-filter');
  assert.equal(messages.length, 4);

  assert.equal(messages[0].text, 'Привет <b> :party:');
  assert.equal(messages[0].messageType, 'text');
  assert.equal(messages[0].nativeEmotes.length, 1);
  assert.equal(messages[0].nativeEmotes[0].url, 'https://yt3.ggpht.com/youtube-emoji');
  assert.equal(messages[0].badges[0].title, 'Member');

  assert.equal(messages[1].messageType, 'paid_message');
  assert.equal(messages[1].amount, '$5.00');
  assert.equal(messages[2].text, 'Участник уже 2 месяца');
  assert.equal(messages[3].text, '100 ₽');
});

test('YouTube author names strip leading @ handle prefix', () => {
  const { connector, messages } = createConnector();
  connector.parseYtLiveChatData(initialFixture);

  assert.equal(messages[0].author, 'viewer');
  assert.equal(messages[1].author, 'supporter');
  assert.equal(messages[2].author, 'member');
  assert.equal(messages[3].author, 'sticker');
  assert.equal(connector.cleanAuthorName('@user_handle'), 'user_handle');
  assert.equal(connector.cleanAuthorName('plain_nick'), 'plain_nick');
  assert.equal(connector.cleanAuthorName('@@nested_at'), 'nested_at');
  assert.equal(connector.cleanAuthorName('@'), 'YTUser');
  assert.equal(connector.cleanAuthorName(''), 'YTUser');
});

test('continuation data is deduplicated and accepts replaceChatItemAction', () => {
  const { connector, messages } = createConnector();
  connector.parseYtLiveChatData(initialFixture);
  const result = connector.parseYtLiveChatData(continuationFixture);

  assert.equal(result.messageCount, 1);
  assert.equal(result.timeoutMs, 3500);
  assert.equal(connector.continuationToken, 'continuation-B');
  assert.equal(messages.length, 6);
  assert.equal(messages[4].isDeleted, true);
  assert.equal(messages[4].id, 'deleted-message');
  assert.equal(messages[5].id, 'text-2');
  assert.equal(messages[5].replyTo, 'name.with-dots');
});

test('only an explicit close action marks the chat as ended', () => {
  const { connector } = createConnector();
  const result = connector.parseYtLiveChatData({
    continuationContents: {
      liveChatContinuation: {
        actions: []
      }
    }
  });

  assert.equal(result.ended, false);
  assert.equal(connector.continuationToken, null);
  assert.equal(connector.parseYtLiveChatData({
    continuationContents: { liveChatContinuation: { actions: [{ closeLiveChatAction: {} }] } }
  }).ended, true);
});

test('YouTube reloads a direct video after an unknown continuation without repeating messages', async t => {
  const urls = [];
  const scheduled = [];
  const { connector, messages, statuses } = createConnector();
  t.after(() => connector.disconnect());
  connector.setTimer = (callback, delay) => { scheduled.push({ callback, delay }); return 1; };
  connector.fetcher = async url => {
    urls.push(new URL(url));
    if (urls.length !== 2) return page(initialFixture);
    return page({ continuationContents: { liveChatContinuation: { continuations: [{ unknownFormat: {} }] } } });
  };

  connector.connect('https://youtu.be/gCNeDWCI0vo');
  await new Promise(resolve => setImmediate(resolve));
  scheduled.shift().callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls[1].searchParams.get('continuation'), 'live-chat-filter');
  assert.equal(scheduled.length, 1);
  assert.equal(connector.continuationToken, null);
  assert.ok(!statuses.some(status => status.description === 'Чат завершён'));

  scheduled.shift().callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls[2].searchParams.get('v'), 'gCNeDWCI0vo');
  assert.equal(messages.length, 4);
});

test('YouTube returns to channel discovery when an old video never yields a usable continuation', async t => {
  const urls = [];
  const scheduled = [];
  const { connector } = createConnector();
  t.after(() => connector.disconnect());
  connector.setTimer = (callback, delay) => { scheduled.push({ callback, delay }); return 1; };
  connector.fetcher = async url => {
    urls.push(new URL(url));
    if (urls.at(-1).pathname.endsWith('/live')) {
      return page({ videoDetails: { videoId: 'gCNeDWCI0vo', isLiveContent: true } }, 'ytInitialPlayerResponse');
    }
    return page({ contents: { liveChatRenderer: { continuations: [] } } });
  };

  connector.connect('@channel');
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 2; i += 1) {
    scheduled.shift().callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(urls.length, 4);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30000);
  scheduled.shift().callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls[4].pathname, '/@channel/live');
});

for (const inputKind of ['handle', 'video']) {
  test(`YouTube resolves an ambiguous bare input as a ${inputKind}`, async t => {
    const urls = [];
    const { connector, messages } = createConnector();
    t.after(() => connector.disconnect());
    connector.fetcher = async url => {
      urls.push(new URL(url));
      if (urls.length > 1) return page(initialFixture);
      return inputKind === 'handle'
        ? page({ videoDetails: { videoId: 'gCNeDWCI0vo', isLiveContent: true } }, 'ytInitialPlayerResponse')
        : new Response('', { status: 404 });
    };

    connector.connect('abcdefghijk');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(urls[0].pathname, '/@abcdefghijk/live');
    assert.equal(urls[1].searchParams.get('v'), inputKind === 'handle' ? 'gCNeDWCI0vo' : 'abcdefghijk');
    assert.equal(messages.length, 4);
  });
}

test('chat polling uses the traffic-safe interval from JS configuration', () => {
  let scheduledDelay = null;
  const connector = new YoutubeConnector(
    () => {},
    () => {},
    {
      setTimer: (callback, delay) => {
        scheduledDelay = delay;
        return 1;
      },
      clearTimer() {}
    }
  );
  connector.channelOrVideo = '@channel';

  connector.schedulePoll('gCNeDWCI0vo', connector.connectionId, 1000);

  assert.equal(scheduledDelay, 5000);
});

test('a stale request cannot publish messages after reconnect', async () => {
  const html = `<script>window["ytInitialData"] = ${JSON.stringify(initialFixture)};</script>`;
  let releaseFirstRequest;
  let requestCount = 0;
  const firstResponse = new Promise(resolve => {
    releaseFirstRequest = () => resolve(new Response(html));
  });
  const messages = [];
  const connector = new YoutubeConnector(
    message => messages.push(message),
    () => {},
    {
      fetcher: () => {
        requestCount += 1;
        return requestCount === 1 ? firstResponse : Promise.resolve(new Response(html));
      },
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      setTimer: () => 1,
      clearTimer() {}
    }
  );

  connector.connect('https://youtu.be/aaaaaaaaaaa');
  connector.connect('https://youtu.be/bbbbbbbbbbb');
  releaseFirstRequest();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(messages.length, 4);
  connector.disconnect();
});

test('fetchText times out without leaving the connection stuck', async () => {
  const connector = new YoutubeConnector(
    () => {},
    () => {},
    {
      fetcher: () => new Promise(() => {}),
      requestTimeoutMs: 5,
      logger: {
        info() {},
        warn() {},
        error() {}
      }
    }
  );
  connector.channelOrVideo = 'gCNeDWCI0vo';
  connector.abortController = new AbortController();

  await assert.rejects(
    connector.fetchText('https://www.youtube.com/live_chat?v=gCNeDWCI0vo', connector.connectionId),
    error => error.code === 'FETCH_TIMEOUT'
  );
  connector.disconnect();
});

test('fetchText deadline includes a stalled response body and aborts transport', async () => {
  let signal;
  const connector = new YoutubeConnector(() => {}, () => {}, {
    requestTimeoutMs: 10,
    fetcher: async (_url, init) => {
      signal = init.signal;
      return { ok: true, text: () => new Promise(() => {}) };
    }
  });
  connector.channelOrVideo = 'aaaaaaaaaaa';
  connector.abortController = new AbortController();
  await assert.rejects(connector.fetchText('https://www.youtube.com/live_chat', 0), error => error.code === 'FETCH_TIMEOUT');
  assert.equal(signal.aborted, true);
  connector.disconnect();
});

test('disconnect interrupts body reading even if the transport ignores abort', async () => {
  let signal;
  const connector = new YoutubeConnector(() => {}, () => {}, {
    fetcher: async (_url, init) => {
      signal = init.signal;
      return { ok: true, text: () => new Promise(() => {}) };
    }
  });
  connector.channelOrVideo = 'aaaaaaaaaaa';
  connector.abortController = new AbortController();
  const reading = connector.fetchText('https://www.youtube.com/live_chat', 0);
  await new Promise(resolve => setImmediate(resolve));
  connector.disconnect();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
});

test('body timeout schedules a polling retry instead of stalling the chat', async () => {
  const scheduled = [];
  const connector = new YoutubeConnector(() => {}, () => {}, {
    requestTimeoutMs: 5,
    fetcher: async () => ({ ok: true, text: () => new Promise(() => {}) }),
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return 1; },
    clearTimer() {},
    logger: { info() {}, warn() {}, error() {} }
  });
  connector.channelOrVideo = 'aaaaaaaaaaa';
  connector.abortController = new AbortController();
  await connector.pollChat('aaaaaaaaaaa', 0);
  assert.equal(connector.consecutiveErrors, 1);
  assert.equal(scheduled.length, 1);
  connector.disconnect();
});
