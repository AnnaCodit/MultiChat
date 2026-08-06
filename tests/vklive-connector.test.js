const test = require('node:test');
const assert = require('node:assert/strict');
const VkLiveConnector = require('../js/connectors/vklive.js');

function createConnector(options = {}) {
  const messages = [];
  const statuses = [];
  const scheduled = [];
  const cleared = [];
  const connector = new VkLiveConnector(
    message => messages.push(message),
    (platform, active, description) => statuses.push({ platform, active, description }),
    {
      fetcher: options.fetcher || (async () => ({ json: async () => ({ data: [] }) })),
      createWebSocket: options.createWebSocket || (() => ({ close() {}, send() {} })),
      setTimer: options.setTimer || ((callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      }),
      clearTimer: options.clearTimer || (timerId => cleared.push(timerId)),
      logger: {
        info() {},
        warn() {},
        error() {}
      }
    }
  );

  return { connector, messages, statuses, scheduled, cleared };
}

function pollingMessage(id, createdAt, text) {
  return {
    id,
    createdAt,
    author: {
      displayName: `Viewer ${id}`,
      nickColor: '#123456'
    },
    data: [
      {
        type: 'text',
        content: JSON.stringify([text, 'unstyled', []])
      }
    ]
  };
}

test('VK recent-message polling interval is kept in JS configuration', () => {
  const { connector } = createConnector();
  connector.channel = 'fra3a';

  assert.equal(VkLiveConnector.CONFIG.pollIntervalMs, 4000);
  assert.equal(
    connector.buildPollingUrl(),
    'https://api.live.vkvideo.ru/v1/blog/fra3a/public_video_stream/chat?limit=20'
  );
});

test('failed WebSocket switches to polling and schedules the next request after four seconds', async () => {
  let socket;
  const requestedUrls = [];
  const context = createConnector({
    createWebSocket: url => {
      socket = { url, close() {}, send() {} };
      return socket;
    },
    fetcher: async url => {
      requestedUrls.push(url);
      return { json: async () => ({ data: [] }) };
    }
  });
  context.connector.channel = 'fra3a';
  context.connector.initCentrifugoWS('guest-token');

  socket.onclose({ code: 1006, reason: '' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(requestedUrls.length, 1);
  assert.equal(context.scheduled.length, 1);
  assert.equal(context.scheduled[0].delay, 4000);
  assert.ok(context.statuses.some(status => status.active && /резервный режим/.test(status.description)));
});

test('polling emits messages chronologically and deduplicates repeated responses', async () => {
  const responses = [
    {
      data: [
        pollingMessage(2, 200, 'Второе'),
        pollingMessage(1, 100, 'Первое')
      ]
    },
    {
      data: [
        pollingMessage(3, 300, 'Третье'),
        pollingMessage(2, 200, 'Второе')
      ]
    }
  ];
  const context = createConnector({
    fetcher: async () => ({ json: async () => responses.shift() })
  });
  context.connector.channel = 'fra3a';

  await context.connector.startPolling(context.connector.connectionId);
  await context.scheduled[0].callback();

  assert.deepEqual(context.messages.map(message => message.text), ['Первое', 'Второе', 'Третье']);
  assert.equal(context.messages[0].author, 'Viewer 1');
  assert.equal(context.messages[0].color, '#123456');
});

test('disconnect aborts an in-flight poll and prevents stale messages from being published', async () => {
  let releaseRequest;
  const pendingResponse = new Promise(resolve => {
    releaseRequest = () => resolve({
      json: async () => ({ data: [pollingMessage(1, 100, 'Устаревшее')] })
    });
  });
  const context = createConnector({ fetcher: () => pendingResponse });
  context.connector.channel = 'fra3a';

  const pollPromise = context.connector.startPolling(context.connector.connectionId);
  context.connector.disconnect();
  releaseRequest();
  await pollPromise;

  assert.equal(context.messages.length, 0);
  assert.equal(context.scheduled.length, 0);
});
