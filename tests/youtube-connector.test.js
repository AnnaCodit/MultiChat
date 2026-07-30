const test = require('node:test');
const assert = require('node:assert/strict');
const YoutubeConnector = require('../js/connectors/youtube.js');
const initialFixture = require('./fixtures/youtube-initial-data.json');
const continuationFixture = require('./fixtures/youtube-continuation-data.json');

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

test('missing continuation marks the chat as ended', () => {
  const { connector } = createConnector();
  const result = connector.parseYtLiveChatData({
    continuationContents: {
      liveChatContinuation: {
        actions: []
      }
    }
  });

  assert.equal(result.ended, true);
  assert.equal(connector.continuationToken, null);
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

  connector.connect('aaaaaaaaaaa');
  connector.connect('bbbbbbbbbbb');
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
