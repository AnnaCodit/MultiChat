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

  assert.equal(VkLiveConnector.CONFIG.pollIntervalMs, 3000);
  assert.equal(
    connector.buildPollingUrl(),
    'https://api.live.vkvideo.ru/v1/blog/fra3a/public_video_stream/chat?limit=20'
  );
});

test('failed WebSocket switches to polling and schedules the next request after three seconds', async () => {
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
  assert.equal(context.scheduled[0].delay, 3000);
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

test('numeric VK nickname colors are converted from palette indexes to CSS colors', () => {
  const context = createConnector();
  const colors = [0, 5, 12, 13];

  colors.forEach((nickColor, index) => {
    const message = pollingMessage(index + 1, index + 1, `Сообщение ${index + 1}`);
    message.author.nickColor = nickColor;
    context.connector.handleCentrifugoPublication(message);
  });

  assert.deepEqual(
    context.messages.map(message => message.color),
    ['#D66E34', '#E73629', '#A36C59', '#8BA259']
  );
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

for (const stage of ['channel headers', 'channel body', 'page headers', 'page body']) {
  for (const action of ['switch', 'disconnect']) {
    test(`VK ignores stale ${stage} after ${action}`, async t => {
      let release;
      let oldSignal;
      const pending = new Promise(resolve => { release = resolve; });
      const oldChannel = { data: { channel: { id: 'old-id' } } };
      const oldPage = '{"wsToken":"old-token"}';
      const sockets = [];
      const requested = [];
      const context = createConnector({
        createWebSocket: () => {
          const socket = { send() {}, close() { this.closed = true; } };
          sockets.push(socket);
          return socket;
        },
        fetcher: async (url, init) => {
          requested.push(url);
          if (url.endsWith('/newchannel')) {
            return { json: async () => ({ data: { channel: { id: 'new-id' } } }), text: async () => '{"wsToken":"new-token"}' };
          }
          oldSignal = init.signal;
          const isChannel = url.includes('/v1/channel/');
          const response = isChannel
            ? { json: () => stage === 'channel body' ? pending : Promise.resolve(oldChannel) }
            : { text: () => stage === 'page body' ? pending : Promise.resolve(oldPage) };
          if ((isChannel && stage === 'channel headers') || (!isChannel && stage === 'page headers')) return pending;
          return response;
        }
      });
      const { connector } = context;
      t.after(() => connector.disconnect());
      const connecting = connector.connect('oldchannel');
      await new Promise(resolve => setImmediate(resolve));
      if (action === 'switch') await connector.connect('newchannel');
      else connector.disconnect();
      assert.equal(oldSignal.aborted, true);
      const currentSocket = connector.ws;
      const currentChannelId = connector.channelId;
      const requestCount = requested.length;
      if (stage === 'channel headers') release({ json: async () => oldChannel });
      else if (stage === 'channel body') release(oldChannel);
      else if (stage === 'page headers') release({ text: async () => oldPage });
      else release(oldPage);
      await connecting;
      assert.equal(connector.channel, action === 'switch' ? 'newchannel' : '');
      assert.equal(connector.channelId, currentChannelId);
      assert.equal(connector.ws, currentSocket);
      assert.equal(sockets.length, action === 'switch' ? 1 : 0);
      assert.equal(requested.length, requestCount);
      assert.equal(context.scheduled.length, 0);
    });
  }
}

test('VK ignores queued events from a replaced socket', () => {
  const { connector, messages, statuses, scheduled } = createConnector();
  connector.channel = 'oldchannel';
  connector.initCentrifugoWS('old-token');
  const old = connector.ws;
  const callbacks = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  connector.disconnect();
  connector.channel = 'newchannel';
  connector.initCentrifugoWS('new-token');
  const currentSocket = connector.ws;
  const statusCount = statuses.length;
  callbacks.open();
  callbacks.message({ data: JSON.stringify({ push: { pub: { data: pollingMessage(1, 1, 'stale') } } }) });
  callbacks.close({ code: 1006, reason: '' });
  callbacks.error(new Error('stale'));
  assert.equal(connector.ws, currentSocket);
  assert.equal(messages.length, 0);
  assert.equal(statuses.length, statusCount);
  assert.equal(scheduled.length, 0);
  connector.disconnect();
});
