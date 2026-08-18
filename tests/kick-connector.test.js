const test = require('node:test');
const assert = require('node:assert/strict');
const KickConnector = require('../js/connectors/kick.js');
const { CONFIG, KICK_CONNECTOR_CONFIG } = KickConnector;

function createConnector(options = {}) {
  const messages = [];
  const statuses = [];
  const connector = new KickConnector(
    message => messages.push(message),
    (platform, isConnected, description, viewerCount) => {
      statuses.push({ platform, isConnected, description, viewerCount });
    },
    {
      fetcher: options.fetcher || (async () => ({ ok: true, json: async () => ({ livestream: null }) })),
      ...options
    }
  );

  return { connector, messages, statuses };
}

test('KICK_CONNECTOR_CONFIG has viewerPollIntervalMs set to 20000', () => {
  const config = KICK_CONNECTOR_CONFIG || CONFIG;
  assert.ok(config, 'KICK_CONNECTOR_CONFIG must be defined');
  assert.equal(config.viewerPollIntervalMs, 20000);
  assert.ok(Object.isFrozen(config), 'KICK_CONNECTOR_CONFIG should be frozen');
});

test('fetchViewerCount correctly parses data.livestream.viewer_count when stream is online', async () => {
  const mockData = {
    id: 12345,
    user_id: 67890,
    livestream: {
      id: 9999,
      viewer_count: 1420
    }
  };

  const { connector, statuses } = createConnector({
    fetcher: async (url) => {
      assert.equal(url, 'https://kick.com/api/v2/channels/testchannel');
      return {
        ok: true,
        json: async () => mockData
      };
    }
  });

  connector.channel = 'testchannel';
  const result = await connector.fetchViewerCount();

  assert.equal(result, 1420);
  assert.equal(connector.viewerCount, 1420);
  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], {
    platform: 'kick',
    isConnected: true,
    description: 'Онлайн (testchannel)',
    viewerCount: 1420
  });
});

test('fetchViewerCount returns null when data.livestream is null (stream offline)', async () => {
  const mockData = {
    id: 12345,
    user_id: 67890,
    livestream: null
  };

  const { connector, statuses } = createConnector({
    fetcher: async () => ({
      ok: true,
      json: async () => mockData
    })
  });

  connector.channel = 'offlinechannel';
  const result = await connector.fetchViewerCount();

  assert.equal(result, null);
  assert.equal(connector.viewerCount, null);
  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], {
    platform: 'kick',
    isConnected: true,
    description: 'Онлайн (offlinechannel)',
    viewerCount: null
  });
});

test('fetchViewerCount returns null when livestream is undefined or viewer_count is not a number', async () => {
  const { connector: connectorEmpty } = createConnector({
    fetcher: async () => ({
      ok: true,
      json: async () => ({})
    })
  });
  connectorEmpty.channel = 'testchannel';
  const resEmpty = await connectorEmpty.fetchViewerCount();
  assert.equal(resEmpty, null);
  assert.equal(connectorEmpty.viewerCount, null);

  const { connector: connectorString } = createConnector({
    fetcher: async () => ({
      ok: true,
      json: async () => ({ livestream: { viewer_count: 'invalid' } })
    })
  });
  connectorString.channel = 'testchannel';
  const resString = await connectorString.fetchViewerCount();
  assert.equal(resString, null);
  assert.equal(connectorString.viewerCount, null);
});

test('fetchViewerCount returns null and logs warning on non-ok response or error', async () => {
  const { connector: connector404, statuses: statuses404 } = createConnector({
    fetcher: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' })
    })
  });
  connector404.channel = 'notfoundchannel';
  const result404 = await connector404.fetchViewerCount();
  assert.equal(result404, null);
  assert.equal(statuses404.length, 0);

  const { connector: connectorError, statuses: statusesError } = createConnector({
    fetcher: async () => {
      throw new Error('Network error');
    }
  });
  connectorError.channel = 'errorchannel';
  const resultError = await connectorError.fetchViewerCount();
  assert.equal(resultError, null);
  assert.equal(statusesError.length, 0);
});

test('startViewerPolling and stopViewerPolling manage the polling interval and clear previous timers', async () => {
  let fetchCount = 0;
  const { connector } = createConnector({
    fetcher: async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({ livestream: { viewer_count: 50 } })
      };
    }
  });

  connector.channel = 'testpoll';
  connector.startViewerPolling();

  const firstTimer = connector.viewerPollTimer;
  assert.ok(firstTimer !== null, 'viewerPollTimer should be active');
  assert.equal(fetchCount, 1, 'startViewerPolling should trigger immediate fetch');

  // Calling startViewerPolling again should clear existing timer and start new one
  connector.startViewerPolling();
  assert.ok(connector.viewerPollTimer !== null);
  assert.equal(fetchCount, 2);

  connector.stopViewerPolling();
  assert.equal(connector.viewerPollTimer, null, 'viewerPollTimer should be cleared');
});

test('disconnect and cleanup stop viewer polling and reset state', () => {
  const { connector } = createConnector();
  connector.channel = 'testdisconnect';
  connector.startViewerPolling();

  assert.ok(connector.viewerPollTimer !== null);
  connector.cleanup();
  assert.equal(connector.viewerPollTimer, null);

  connector.channel = 'testdisconnect2';
  connector.startViewerPolling();
  assert.ok(connector.viewerPollTimer !== null);

  connector.disconnect();
  assert.equal(connector.viewerPollTimer, null);
  assert.equal(connector.channel, '');
  assert.equal(connector.viewerCount, null);
});
