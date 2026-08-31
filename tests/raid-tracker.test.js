const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');

function loadRaidTracker() {
  const sandbox = {
    console,
    Date,
    window: {}
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/raidTracker.js'), 'utf8');
  vm.runInContext(source, sandbox);
  return sandbox.window.raidTracker || sandbox.RaidTracker;
}

test('RaidTracker registers raid leader and identifies them within 10-minute window', () => {
  const tracker = loadRaidTracker();
  if (typeof tracker.clear === 'function') tracker.clear();

  const baseTime = 1700000000000;
  tracker.registerRaid({
    leaderLogin: 'superstreamer',
    leaderDisplayName: 'SuperStreamer',
    viewerCount: 150,
    timestamp: baseTime
  });

  // Message with matching login within window
  const isLeaderByLogin = tracker.isRaidLeader({
    platform: 'twitch',
    login: 'superstreamer',
    author: 'SuperStreamer'
  }, baseTime + 5 * 60 * 1000); // 5 minutes later

  assert.equal(isLeaderByLogin, true);

  // Message with matching author / case-insensitivity / leading @
  const isLeaderByAuthor = tracker.isRaidLeader({
    platform: 'twitch',
    login: 'superstreamer',
    author: '@SuperStreamer'
  }, baseTime + 9 * 60 * 1000); // 9 minutes later

  assert.equal(isLeaderByAuthor, true);
});

test('RaidTracker expires raid leader status after 10 minutes', () => {
  const tracker = loadRaidTracker();
  if (typeof tracker.clear === 'function') tracker.clear();

  const baseTime = 1700000000000;
  tracker.registerRaid({
    leaderLogin: 'temporaryraider',
    leaderDisplayName: 'TemporaryRaider',
    viewerCount: 50,
    timestamp: baseTime
  });

  // Exactly at 10 minutes (600,000 ms) -> still active
  assert.equal(tracker.isRaidLeader({
    platform: 'twitch',
    login: 'temporaryraider',
    author: 'TemporaryRaider'
  }, baseTime + 10 * 60 * 1000), true);

  // 10 minutes and 1 ms later -> expired
  assert.equal(tracker.isRaidLeader({
    platform: 'twitch',
    login: 'temporaryraider',
    author: 'TemporaryRaider'
  }, baseTime + 10 * 60 * 1000 + 1), false);
});

test('RaidTracker handles non-matching chatters and missing fields gracefully', () => {
  const tracker = loadRaidTracker();
  if (typeof tracker.clear === 'function') tracker.clear();

  const baseTime = 1700000000000;
  tracker.registerRaid({
    leaderLogin: 'streamer_a',
    leaderDisplayName: 'Streamer A',
    timestamp: baseTime
  });

  assert.equal(tracker.isRaidLeader(null), false);
  assert.equal(tracker.isRaidLeader({}), false);
  assert.equal(tracker.isRaidLeader({ author: 'regular_viewer' }, baseTime), false);
  assert.equal(tracker.isRaidLeader({ platform: 'kick', author: 'streamer_a' }, baseTime), false); // only twitch raids
});

test('RaidTracker uses configured raidLeaderDurationMinutes from settingsManager', () => {
  const sandbox = {
    console,
    Date,
    window: {
      settingsManager: {
        settings: {
          raidLeaderDurationMinutes: 5 // 5 minutes
        }
      }
    }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(projectRoot, 'js/raidTracker.js'), 'utf8');
  vm.runInContext(source, sandbox);
  const tracker = sandbox.window.raidTracker;

  const baseTime = 1700000000000;
  tracker.registerRaid({
    leaderLogin: 'fast_raider',
    leaderDisplayName: 'Fast Raider',
    timestamp: baseTime
  });

  // Active at 5 minutes
  assert.equal(tracker.isRaidLeader({
    platform: 'twitch',
    login: 'fast_raider'
  }, baseTime + 5 * 60 * 1000), true);

  // Expired at 5 minutes and 1 ms
  assert.equal(tracker.isRaidLeader({
    platform: 'twitch',
    login: 'fast_raider'
  }, baseTime + 5 * 60 * 1000 + 1), false);
});

