const test = require('node:test');
const assert = require('node:assert/strict');
const KickConnector = require('../js/connectors/kick.js');

function createConnector(fetcher) {
  const sockets = [];
  const messages = [];
  const statuses = [];
  const connector = new KickConnector(message => messages.push(message), (...args) => statuses.push(args), {
    fetcher,
    createWebSocket: () => {
      const socket = { sent: [], send(value) { this.sent.push(value); }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    }
  });
  return { connector, sockets, messages, statuses };
}

for (const stage of ['headers', 'body']) {
  for (const action of ['switch', 'disconnect']) {
    test(`Kick ignores stale ${stage} after ${action} and aborts the request`, async t => {
      let release;
      let signal;
      let requests = 0;
      const pending = new Promise(resolve => { release = resolve; });
      const payload = { chatroom: { id: 111 } };
      const response = { ok: true, json: () => stage === 'body' ? pending : Promise.resolve(payload) };
      const { connector, sockets } = createConnector((_url, init) => {
        requests += 1;
        if (_url.endsWith('/newchannel')) return Promise.resolve({ ok: true, json: async () => ({ chatroom: { id: 222 } }) });
        signal = init.signal;
        return stage === 'headers' ? pending : Promise.resolve(response);
      });
      t.after(() => connector.disconnect());
      const connecting = connector.connect('oldchannel');
      await new Promise(resolve => setImmediate(resolve));
      if (action === 'switch') await connector.connect('newchannel');
      else connector.disconnect();
      assert.equal(signal.aborted, true);
      const currentSocket = connector.ws;
      release(stage === 'headers' ? response : payload);
      await connecting;
      assert.equal(connector.channel, action === 'switch' ? 'newchannel' : '');
      assert.equal(connector.chatroomId, action === 'switch' ? '222' : null);
      assert.equal(connector.ws, currentSocket);
      assert.equal(sockets.length, action === 'switch' ? 1 : 0);
      assert.equal(requests, action === 'switch' ? 2 : 1);
    });
  }
}

test('Kick subscribes to the resolved room and ignores callbacks from a replaced socket', async t => {
  const context = createConnector(async url => ({ ok: true, json: async () => ({ chatroom: { id: url.endsWith('/newchannel') ? 222 : 111 } }) }));
  const { connector, sockets, messages, statuses } = context;
  t.after(() => connector.disconnect());
  await connector.connect('oldchannel');
  const old = sockets[0];
  const callbacks = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  old.onopen();
  assert.equal(JSON.parse(old.sent[0]).data.channel, 'chatrooms.111.v2');
  await connector.connect('newchannel');
  const statusCount = statuses.length;
  callbacks.open();
  callbacks.message({ data: JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', data: { content: 'stale', sender: { username: 'old' } } }) });
  callbacks.close();
  callbacks.error(new Error('stale'));
  assert.equal(messages.length, 0);
  assert.equal(statuses.length, statusCount);
  assert.equal(connector.ws, sockets[1]);
  assert.equal(old.closed, true);
  assert.equal(connector.reconnectTimer, null);
  assert.equal(connector.pingInterval, null);
  sockets[1].onopen();
  assert.equal(JSON.parse(sockets[1].sent[0]).data.channel, 'chatrooms.222.v2');
});

test('Kick aborted lookup does not fall through to another API request', async () => {
  let signal;
  let calls = 0;
  const { connector, sockets } = createConnector((_url, init) => {
    calls += 1;
    signal = init.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const connecting = connector.connect('oldchannel');
  connector.disconnect();
  await connecting;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(sockets.length, 0);
});

for (const input of ['@Some_Channel', 'https://kick.com/Some_Channel/', '12345']) {
  test(`Kick resolves channel input ${input} through the API`, async t => {
    const urls = [];
    const { connector, sockets } = createConnector(async url => {
      urls.push(url);
      return { ok: true, json: async () => ({ chatroom: { id: 987 } }) };
    });
    t.after(() => connector.disconnect());
    await connector.connect(input);
    assert.equal(urls[0], `https://kick.com/api/v2/channels/${input === '12345' ? '12345' : 'some_channel'}`);
    assert.equal(connector.chatroomId, '987');
    assert.equal(sockets.length, 1);
  });
}

test('Kick does not invent a room for fra3a when metadata is unavailable', async t => {
  const { connector, sockets, statuses } = createConnector(async () => ({ ok: false, status: 503 }));
  t.after(() => connector.disconnect());
  await connector.connect('fra3a');
  assert.equal(connector.chatroomId, null);
  assert.equal(sockets.length, 0);
  assert.ok(connector.reconnectTimer);
  assert.match(statuses.at(-1)[2], /Повтор/);
  connector.disconnect();
  assert.equal(connector.reconnectTimer, null);
});

test('Kick rejects a foreign channel URL without a request', async () => {
  const { connector, sockets } = createConnector(() => { throw new Error('Must not fetch'); });
  await connector.connect('https://example.com/channel');
  assert.equal(sockets.length, 0);
  assert.equal(connector.channel, '');
});

test('Kick channel URL remains a streamer nickname for message filtering', () => {
  const SettingsManager = require('../js/settings.js');
  const settings = Object.create(SettingsManager.prototype);
  settings.settings = { kickChannel: '  https://kick.com/Some_Channel/?tab=chat  ' };
  assert.deepEqual(settings.getStreamerNicknames(), ['some_channel']);
});
