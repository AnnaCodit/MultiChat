const test = require('node:test');
const assert = require('node:assert/strict');
const SevenTvTracker = require('../js/sevenTvTracker');

function createMockLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
}

test('SevenTvTracker: int32ToRgba converts 32-bit signed ints to rgba format correctly', () => {
  const tracker = new SevenTvTracker({ loadPaintsImmediately: false });

  // 853998332: 0x32E6FAFC -> R=50, G=230, B=250, A=252/255=0.988
  assert.equal(tracker.int32ToRgba(853998332), 'rgba(50, 230, 250, 0.988)');

  // -5635841: 0xFFAA00FF -> R=255, G=170, B=0, A=1
  assert.equal(tracker.int32ToRgba(-5635841), 'rgba(255, 170, 0, 1)');

  // -16776961: 0xFF0000FF -> R=255, G=0, B=0, A=1
  assert.equal(tracker.int32ToRgba(-16776961), 'rgba(255, 0, 0, 1)');

  // 0 or alpha=0 (transparent) returns null to fall back to native Twitch color
  assert.equal(tracker.int32ToRgba(0), null);
  assert.equal(tracker.int32ToRgba(0x11223300), null);

  // Invalid / non-number inputs return null
  assert.equal(tracker.int32ToRgba(null), null);
  assert.equal(tracker.int32ToRgba(undefined), null);
  assert.equal(tracker.int32ToRgba(NaN), null);
  assert.equal(tracker.int32ToRgba('not a number'), null);
});

test('SevenTvTracker: parseShadows formats 7TV shadows array into CSS text-shadow', () => {
  const tracker = new SevenTvTracker({ loadPaintsImmediately: false });

  const shadows = [
    { x_offset: 0, y_offset: 0, radius: 4, color: -5635841 },
    { x_offset: 2, y_offset: 2, radius: 8, color: -16776961 }
  ];

  const css = tracker.parseShadows(shadows);
  assert.equal(css, '0px 0px 4px rgba(255, 170, 0, 1), 2px 2px 8px rgba(255, 0, 0, 1)');

  assert.equal(tracker.parseShadows([]), '');
  assert.equal(tracker.parseShadows(null), '');
  assert.equal(tracker.parseShadows(undefined), '');
});

test('SevenTvTracker: parseShadowsToFilter formats shadows into CSS filter drop-shadow', () => {
  const tracker = new SevenTvTracker({ loadPaintsImmediately: false });

  const shadows = [
    { x_offset: 0, y_offset: 0, radius: 4, color: -5635841 },
    { x_offset: 2, y_offset: 2, radius: 8, color: -16776961 }
  ];

  const filter = tracker.parseShadowsToFilter(shadows);
  assert.equal(filter, 'drop-shadow(0px 0px 4px rgba(255, 170, 0, 1)) drop-shadow(2px 2px 8px rgba(255, 0, 0, 1))');

  assert.equal(tracker.parseShadowsToFilter([]), '');
  assert.equal(tracker.parseShadowsToFilter(null), '');
});

test('SevenTvTracker: parsePaint builds gradient, texture, filter, and color', () => {
  const tracker = new SevenTvTracker({ loadPaintsImmediately: false });

  // 1. Radial gradient paint (e.g. Heavy Rain)
  const radialPaint = {
    id: 'paint_radial',
    name: 'Heavy Rain',
    color: null,
    function: 'RADIAL_GRADIENT',
    shape: 'ellipse',
    repeat: true,
    stops: [
      { at: 0.0, color: 525983999 },
      { at: 0.25, color: 16515071 }
    ],
    shadows: [
      { x_offset: 0, y_offset: 0, radius: 4, color: 6488063 }
    ]
  };
  const parsedRadial = tracker.parsePaint(radialPaint);
  assert.equal(parsedRadial.name, 'Heavy Rain');
  assert.match(parsedRadial.backgroundImage, /^repeating-radial-gradient\(ellipse/);
  assert.match(parsedRadial.backgroundImage, /0\.00%/);
  assert.match(parsedRadial.backgroundImage, /25\.00%/);
  assert.equal(parsedRadial.filter, 'drop-shadow(0px 0px 4px rgba(0, 98, 255, 1))');
  assert.equal(parsedRadial.shadow, '0px 0px 4px rgba(0, 98, 255, 1)');

  // 2. Linear gradient paint
  const linearPaint = {
    id: 'paint_linear',
    name: 'Candy Cane',
    function: 'LINEAR_GRADIENT',
    angle: 45,
    repeat: false,
    stops: [
      { at: 0.1, color: -757935361 },
      { at: 0.2, color: -10197761 }
    ]
  };
  const parsedLinear = tracker.parsePaint(linearPaint);
  assert.match(parsedLinear.backgroundImage, /^linear-gradient\(45deg/);

  // 3. Image URL paint
  const urlPaint = {
    id: 'paint_url',
    function: 'URL',
    image_url: 'https://cdn.7tv.app/paint/example.webp'
  };
  const parsedUrl = tracker.parsePaint(urlPaint);
  assert.equal(parsedUrl.backgroundImage, 'url("https://cdn.7tv.app/paint/example.webp")');
});

test('SevenTvTracker: reads and writes compact format to localStorage', () => {
  const mockStorage = createMockLocalStorage();
  global.localStorage = mockStorage;
  let fakeNowSec = 1756684800;

  const tracker = new SevenTvTracker({
    getNow: () => fakeNowSec * 1000,
    loadPaintsImmediately: false
  });

  tracker.cache.set('12345', {
    color: 'rgba(255, 170, 0, 1)',
    shadow: '0px 0px 4px rgba(255, 170, 0, 1)',
    paint: null,
    timestamp: fakeNowSec,
    found: true
  });
  tracker.cache.set('67890', {
    color: null,
    shadow: null,
    paint: null,
    timestamp: fakeNowSec,
    found: false
  });
  tracker.cache.set('user_painted', {
    color: 'rgba(255, 170, 0, 1)',
    shadow: '0px 0px 4px rgba(0, 98, 255, 1)',
    paint: {
      backgroundImage: 'repeating-radial-gradient(circle, #fff, #000)',
      filter: 'drop-shadow(0px 0px 4px #000)'
    },
    timestamp: fakeNowSec,
    found: true
  });
  tracker.saveToStorage();

  const rawSaved = mockStorage.getItem('multichat_7tv_cache');
  assert.ok(rawSaved, 'Should save to multichat_7tv_cache');
  const parsed = JSON.parse(rawSaved);
  assert.deepEqual(parsed['12345'], ['rgba(255, 170, 0, 1)', '0px 0px 4px rgba(255, 170, 0, 1)', fakeNowSec, 1]);
  assert.deepEqual(parsed['67890'], [null, null, fakeNowSec, 0]);
  assert.deepEqual(parsed['user_painted'], [
    'rgba(255, 170, 0, 1)',
    '0px 0px 4px rgba(0, 98, 255, 1)',
    fakeNowSec,
    1,
    'repeating-radial-gradient(circle, #fff, #000)',
    'drop-shadow(0px 0px 4px #000)'
  ]);

  // Restore on new instance
  const tracker2 = new SevenTvTracker({
    getNow: () => fakeNowSec * 1000,
    loadPaintsImmediately: false
  });

  const style1 = tracker2.getStyle('12345');
  assert.equal(style1.color, 'rgba(255, 170, 0, 1)');
  assert.equal(style1.shadow, '0px 0px 4px rgba(255, 170, 0, 1)');

  const style2 = tracker2.getStyle('67890');
  assert.equal(style2.color, null);
  assert.equal(style2.shadow, null);

  const stylePainted = tracker2.getStyle('user_painted');
  assert.ok(stylePainted.paint);
  assert.equal(stylePainted.paint.backgroundImage, 'repeating-radial-gradient(circle, #fff, #000)');
  assert.equal(stylePainted.paint.filter, 'drop-shadow(0px 0px 4px #000)');
});

test('SevenTvTracker: respects positive TTL (7 days) and negative TTL (1 day)', () => {
  let fakeNowSec = 1756684800;

  const tracker = new SevenTvTracker({
    getNow: () => fakeNowSec * 1000,
    positiveTtlSeconds: 7 * 86400,
    negativeTtlSeconds: 86400,
    loadPaintsImmediately: false
  });

  tracker.cache.set('found_user', {
    color: 'rgba(255, 0, 0, 1)',
    shadow: null,
    timestamp: fakeNowSec,
    found: true
  });
  tracker.cache.set('not_found_user', {
    color: null,
    shadow: null,
    timestamp: fakeNowSec,
    found: false
  });

  // Advance time by 2 days: negative cache should expire, positive cache should remain valid
  fakeNowSec += 2 * 86400;
  assert.equal(tracker.getStyle('not_found_user'), null, 'Negative cache should expire after 1 day');
  assert.ok(tracker.getStyle('found_user'), 'Positive cache should remain valid after 2 days');

  // Advance time past 7 days: positive cache should expire
  fakeNowSec += 6 * 86400; // total 8 days
  assert.equal(tracker.getStyle('found_user'), null, 'Positive cache should expire after 7 days');
});

test('SevenTvTracker: throttled queue processes lookups sequentially and notifies subscribers', async () => {
  const fakeNowSec = 1756684800;

  const mockFetcher = async (url) => {
    if (url.includes('11111')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            style: {
              color: -5635841,
              paint_id: 'paint1'
            }
          }
        })
      };
    }
    if (url.includes('22222')) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'user not found' })
      };
    }
    throw new Error('Network error');
  };

  const tracker = new SevenTvTracker({
    fetcher: mockFetcher,
    queueDelayMs: 10,
    getNow: () => fakeNowSec * 1000,
    loadPaintsImmediately: false
  });

  tracker.paintsMap.set('paint1', '0px 0px 6px rgba(255, 170, 0, 1)');

  const detectedEvents = [];
  tracker.onStyleDetected((userId, style) => {
    detectedEvents.push({ userId, style });
  });

  tracker.queueCheck('11111');
  tracker.queueCheck('22222');

  // Wait for queue to process both items
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(detectedEvents.length, 1);
  assert.equal(detectedEvents[0].userId, '11111');
  assert.equal(detectedEvents[0].style.color, 'rgba(255, 170, 0, 1)');
  assert.equal(detectedEvents[0].style.shadow, '0px 0px 6px rgba(255, 170, 0, 1)');

  // Verify negative cache for 22222
  const notFoundStyle = tracker.getStyle('22222');
  assert.equal(notFoundStyle.color, null);
  assert.equal(notFoundStyle.shadow, null);
});

test('SevenTvTracker: caps queue size to prevent infinite backlog during raids', () => {
  const tracker = new SevenTvTracker({
    maxQueueSize: 3,
    loadPaintsImmediately: false
  });

  tracker.isProcessing = true; // Hold processing to inspect queue buffer
  tracker.queueCheck('1');
  tracker.queueCheck('2');
  tracker.queueCheck('3');
  assert.equal(tracker.queue.length, 3);
  assert.deepEqual(tracker.queue, ['1', '2', '3']);

  tracker.queueCheck('4');
  assert.equal(tracker.queue.length, 3);
  assert.deepEqual(tracker.queue, ['2', '3', '4']);
  assert.ok(!tracker.pendingSet.has('1'), 'Dropped item should be evicted from pendingSet');
});

test('SevenTvTracker: pruneCache limits maximum stored entries and removes oldest', () => {
  let fakeNowSec = 1756684800;

  const tracker = new SevenTvTracker({
    maxStorageEntries: 3,
    getNow: () => fakeNowSec * 1000,
    loadPaintsImmediately: false
  });

  tracker.cache.set('userA', { color: 'red', shadow: null, timestamp: fakeNowSec, found: true });
  tracker.cache.set('userB', { color: 'blue', shadow: null, timestamp: fakeNowSec, found: true });
  tracker.cache.set('userC', { color: 'green', shadow: null, timestamp: fakeNowSec, found: true });
  tracker.cache.set('userD', { color: 'yellow', shadow: null, timestamp: fakeNowSec, found: true });

  tracker.pruneCache();
  assert.equal(tracker.cache.size, 3);
  assert.equal(tracker.cache.has('userA'), false, 'Oldest entry userA should be pruned');
  assert.equal(tracker.cache.has('userD'), true);
});

test('SevenTvTracker: loads global cosmetic paints via GraphQL query', async () => {
  const mockFetcher = async (url, init) => {
    assert.match(url, /\/gql$/);
    return {
      ok: true,
      json: async () => ({
        data: {
          cosmetics: {
            paints: [
              {
                id: 'paint_glow',
                shadows: [{ x_offset: 1, y_offset: 1, radius: 5, color: -16776961 }]
              }
            ]
          }
        }
      })
    };
  };

  const tracker = new SevenTvTracker({
    fetcher: mockFetcher,
    loadPaintsImmediately: false
  });

  await tracker.loadGlobalPaints();
  assert.equal(tracker.paintsLoaded, true);
  assert.equal(tracker.paintsMap.has('paint_glow'), true);
  assert.equal(tracker.paintsMap.get('paint_glow').shadow, '1px 1px 5px rgba(255, 0, 0, 1)');
  assert.equal(tracker.paintsMap.get('paint_glow').filter, 'drop-shadow(1px 1px 5px rgba(255, 0, 0, 1))');
});
