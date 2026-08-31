const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadStreamerTracker(extraSandbox = {}) {
  const localStorageStore = new Map();
  const defaultLocalStorage = {
    getItem: (key) => localStorageStore.get(key) || null,
    setItem: (key, val) => localStorageStore.set(key, String(val)),
    removeItem: (key) => localStorageStore.delete(key),
    clear: () => localStorageStore.clear()
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: defaultLocalStorage,
    setTimeout,
    clearTimeout,
    Object,
    Array,
    Set,
    Map,
    JSON,
    Date,
    String,
    Number,
    Boolean,
    window: {},
    ...extraSandbox
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/streamerTracker.js'), 'utf8');
  vm.runInContext(`${source}\nthis.StreamerTracker = StreamerTracker;\nthis.STREAMER_TRACKER_CONFIG = STREAMER_TRACKER_CONFIG;`, sandbox);
  return { StreamerTracker: sandbox.StreamerTracker, config: sandbox.STREAMER_TRACKER_CONFIG, sandbox };
}

test('StreamerTracker: reads and writes compact [avg, timestamp] format to localStorage', () => {
  const { StreamerTracker, sandbox } = loadStreamerTracker();
  let fakeNowSec = 1756684800;

  const tracker = new StreamerTracker({
    getNow: () => fakeNowSec * 1000
  });

  // Seed cache manually and save
  tracker.cache.set('fra3a', { avgViewers: 105, timestamp: fakeNowSec });
  tracker.cache.set('viewer1', { avgViewers: 0, timestamp: fakeNowSec });
  tracker.saveToStorage();

  const rawSaved = sandbox.localStorage.getItem('multichat_streamer_cache');
  assert.ok(rawSaved, 'Should save to multichat_streamer_cache');
  const parsed = JSON.parse(rawSaved);
  assert.deepEqual(parsed, {
    fra3a: [105, fakeNowSec],
    viewer1: [0, fakeNowSec]
  });

  // Create a new instance and ensure it loads compact format
  const tracker2 = new StreamerTracker({
    getNow: () => fakeNowSec * 1000
  });
  const statsFra3a = tracker2.getStreamerStats('fra3a');
  assert.equal(statsFra3a.avgViewers, 105);
  assert.equal(statsFra3a.isStreamer, true);
  assert.equal(statsFra3a.timestamp, fakeNowSec);
  assert.equal(statsFra3a.cached, true);

  const statsViewer = tracker2.getStreamerStats('viewer1');
  assert.equal(statsViewer.avgViewers, 0);
  assert.equal(statsViewer.isStreamer, false);
  assert.equal(statsViewer.timestamp, fakeNowSec);
  assert.equal(statsViewer.cached, true);
});

test('StreamerTracker: respects 7-day TTL expiration', () => {
  const { StreamerTracker } = loadStreamerTracker();
  let fakeNowSec = 1756684800;

  const tracker = new StreamerTracker({
    getNow: () => fakeNowSec * 1000,
    ttlSeconds: 7 * 86400
  });

  tracker.cache.set('streamer_old', { avgViewers: 50, timestamp: fakeNowSec });
  assert.ok(tracker.getStreamerStats('streamer_old'));

  // Advance time by 8 days (expired)
  fakeNowSec += 8 * 86400;
  assert.equal(tracker.getStreamerStats('streamer_old'), null);
});

test('StreamerTracker: normalizes logins with leading @ and uppercase characters', () => {
  const { StreamerTracker } = loadStreamerTracker();
  const tracker = new StreamerTracker({
    getNow: () => 1756684800000
  });

  tracker.cache.set('fra3a', { avgViewers: 100, timestamp: 1756684800 });
  assert.equal(tracker.getStreamerStats('@FRA3A')?.avgViewers, 100);
  assert.equal(tracker.getStreamerStats('  #fra3a  ')?.avgViewers, 100);
});

test('StreamerTracker: throttled queue processes lookups sequentially and notifies callback', async () => {
  const fetchedCalls = [];
  const detectedStreamers = [];

  const fakeFetcher = async (url) => {
    fetchedCalls.push(url);
    if (url.includes('streamer_pro')) {
      return { ok: true, status: 200, json: async () => ({ avg_viewers: 250 }) };
    }
    if (url.includes('regular_guy')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { StreamerTracker } = loadStreamerTracker();
  const tracker = new StreamerTracker({
    queueDelayMs: 10,
    fetcher: fakeFetcher,
    getNow: () => 1756684800000
  });

  tracker.onStreamerDetected((login, avgViewers) => {
    detectedStreamers.push({ login, avgViewers });
  });

  tracker.queueCheck('streamer_pro');
  tracker.queueCheck('regular_guy');
  tracker.queueCheck('streamer_pro'); // duplicate should be ignored

  // Wait for processing
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(fetchedCalls.length, 2, 'Should only fetch 2 unique users');
  assert.match(fetchedCalls[0], /streamer_pro/);
  assert.match(fetchedCalls[1], /regular_guy/);

  assert.deepEqual(detectedStreamers, [{ login: 'streamer_pro', avgViewers: 250 }]);
  assert.equal(tracker.getStreamerStats('streamer_pro')?.avgViewers, 250);
  assert.equal(tracker.getStreamerStats('regular_guy')?.avgViewers, 0);
});

test('StreamerTracker: queue size is capped to prevent infinite backlog during raids', () => {
  const { StreamerTracker } = loadStreamerTracker();
  const tracker = new StreamerTracker({
    queueDelayMs: 1000, // slow queue to simulate pending backlog
    maxQueueSize: 3,
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    getNow: () => 1756684800000
  });

  // Temporarily block processing to check backlog capping
  tracker.isProcessing = true;

  tracker.queueCheck('user1');
  tracker.queueCheck('user2');
  tracker.queueCheck('user3');
  tracker.queueCheck('user4');
  tracker.queueCheck('user5');

  // Should have dropped user1 and user2, keeping only 3 newest items
  assert.equal(tracker.queue.length, 3);
  assert.deepEqual(Array.from(tracker.queue), ['user3', 'user4', 'user5']);
  assert.ok(!tracker.pendingSet.has('user1'));
  assert.ok(tracker.pendingSet.has('user5'));
});

test('StreamerTracker: pruneCache limits maximum stored entries and removes oldest', () => {
  const { StreamerTracker } = loadStreamerTracker();
  const fakeNowSec = 1756684800;
  const tracker = new StreamerTracker({
    maxStorageEntries: 3,
    getNow: () => fakeNowSec * 1000
  });

  tracker.cache.set('user1', { avgViewers: 10, timestamp: fakeNowSec - 400 });
  tracker.cache.set('user2', { avgViewers: 20, timestamp: fakeNowSec - 300 });
  tracker.cache.set('user3', { avgViewers: 30, timestamp: fakeNowSec - 200 });
  tracker.cache.set('user4', { avgViewers: 40, timestamp: fakeNowSec - 100 });

  tracker.pruneCache();

  assert.equal(tracker.cache.size, 3);
  assert.ok(!tracker.cache.has('user1'), 'Oldest entry user1 should be pruned');
  assert.ok(tracker.cache.has('user2'));
  assert.ok(tracker.cache.has('user3'));
  assert.ok(tracker.cache.has('user4'));
});

