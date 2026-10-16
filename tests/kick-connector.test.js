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

test('Kick connector uses the active 2026 Pusher key by default', async t => {
  let createdUrl = null;
  const sockets = [];
  const connector = new KickConnector(() => {}, () => {}, {
    fetcher: async () => ({ ok: true, json: async () => ({ chatroom: { id: 777 } }) }),
    createWebSocket: (url) => {
      createdUrl = url;
      const socket = { sent: [], send(v) { this.sent.push(v); }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    }
  });
  t.after(() => connector.disconnect());
  await connector.connect('testchannel');
  assert.ok(createdUrl, 'WebSocket URL was created');
  assert.match(createdUrl, /34bf7a0ff419a2a775b9/, 'URL must use the active Pusher key 34bf7a0ff419a2a775b9');
  assert.match(createdUrl, /ws-us2\.pusher\.com/, 'URL must use us2 cluster');
});

test('Kick connector rotates Pusher key on 4001 refusal and handles pusher:ping', async t => {
  const createdUrls = [];
  const sockets = [];
  const connector = new KickConnector(() => {}, () => {}, {
    fetcher: async () => ({ ok: true, json: async () => ({ chatroom: { id: 888 } }) }),
    createWebSocket: (url) => {
      createdUrls.push(url);
      const socket = { sent: [], send(v) { this.sent.push(v); }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    pusherConfig: {
      knownKeys: ['first-key', 'second-key'],
      cluster: 'us2'
    }
  });
  t.after(() => connector.disconnect());
  await connector.connect('testchannel');

  assert.equal(createdUrls.length, 1);
  assert.match(createdUrls[0], /first-key/);

  const socket1 = sockets[0];
  socket1.onopen();
  // Simulate Pusher ping
  socket1.onmessage({ data: JSON.stringify({ event: 'pusher:ping' }) });
  assert.ok(socket1.sent.some(s => JSON.parse(s).event === 'pusher:pong'), 'Responded to ping with pong');

  // Simulate Pusher error 4001
  socket1.onmessage({ data: JSON.stringify({ event: 'pusher:error', data: { code: 4001, message: 'App key first-key not in this cluster' } }) });
  socket1.onclose({ code: 4001, reason: 'Refused' });

  // Fast forward the reconnect timer
  await new Promise(resolve => setTimeout(resolve, 1100));

  assert.equal(createdUrls.length, 2, 'Connector reconnected with next key');
  assert.match(createdUrls[1], /second-key/, 'Second attempt used fallback key');

  // Second connection succeeds
  const socket2 = sockets[1];
  socket2.onopen();
  socket2.onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '123' }) }) });
  assert.equal(connector.currentKey, 'second-key');
});

test('Kick connector cycles through multiple fallback keys without getting stuck in infinite loop', async t => {
  const createdUrls = [];
  const sockets = [];
  const connector = new KickConnector(() => {}, () => {}, {
    fetcher: async () => ({ ok: true, json: async () => ({ chatroom: { id: 999 } }) }),
    createWebSocket: (url) => {
      createdUrls.push(url);
      const socket = { sent: [], send(v) { this.sent.push(v); }, close() { this.closed = true; } };
      sockets.push(socket);
      return socket;
    },
    pusherConfig: {
      knownKeys: ['key-A', 'key-B', 'key-C'],
      cluster: 'us2'
    }
  });
  t.after(() => connector.disconnect());
  await connector.connect('testchannel');

  assert.match(createdUrls[0], /key-A/);

  // Failure 1: key-A fails
  sockets[0].onopen();
  sockets[0].onmessage({ data: JSON.stringify({ event: 'pusher:error', data: { code: 4001, message: 'not in this cluster' } }) });
  sockets[0].onclose({ code: 4001, reason: 'Refused' });
  await new Promise(r => setTimeout(r, 1100));

  assert.equal(createdUrls.length, 2);
  assert.match(createdUrls[1], /key-B/);

  // Failure 2: key-B fails with non-JSON string error payload
  sockets[1].onopen();
  sockets[1].onmessage({ data: JSON.stringify({ event: 'pusher:error', data: 'App key key-B not in this cluster' }) });
  sockets[1].onclose({ code: 4001, reason: 'Refused' });
  await new Promise(r => setTimeout(r, 1100));

  assert.equal(createdUrls.length, 3);
  assert.match(createdUrls[2], /key-C/);

  // Failure 3: key-C fails (cycles back to key-A)
  sockets[2].onopen();
  sockets[2].onclose({ code: 4001, reason: 'Refused' });
  assert.equal(connector.currentKey, 'key-A');
});
