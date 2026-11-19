const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const windowsPhp = 'C:/laragon/bin/php/php-8.4.5-nts-Win32-vs17-x64/php.exe';
const php = process.env.PHP_BINARY || (fs.existsSync(windowsPhp) ? windowsPhp : 'php');
const available = spawnSync(php, ['-v']).status === 0;

function runProxyTest(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-kick-test-'));
  try {
    // Load production functions without running the HTTP entry point or reading secrets.
    const source = fs.readFileSync(path.join(__dirname, '../proxy/index.php'), 'utf8');
    fs.writeFileSync(path.join(dir, 'functions.php'), source.split('\napplyCorsHeaders();')[0]);
    const entry = `<?php
      require 'functions.php';
      function check($condition) {
        if (!$condition) throw new RuntimeException('Proxy assertion failed at line ' . debug_backtrace()[0]['line']);
      }
      ${script}
      echo 'OK';
    `;
    fs.writeFileSync(path.join(dir, 'test.php'), entry);
    const result = spawnSync(php, ['test.php'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, 'OK');
  } finally {
    // mkdtemp creates this isolated test directory under the OS temp directory.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PHP routes Kick through upstream and caches only valid channel responses', { skip: !available }, () => {
  runProxyTest(`
    check(shouldUseUpstreamProxy('https://kick.com/api/v2/channels/anyone'));
    check(shouldUseUpstreamProxy('https://www.youtube.com/live_chat'));
    check(!shouldUseUpstreamProxy('https://kick.com.evil.test/'));
    check(!shouldUseUpstreamProxy('https://api.live.vkvideo.ru/'));
    $url = 'https://kick.com/api/v2/channels/anyone';
    $body = json_encode(['slug' => 'anyone', 'chatroom' => ['id' => 987], 'emotes' => [['id' => 123]]]);
    $cache = sys_get_temp_dir() . '/multichat-kick-' . sha1(__DIR__) . '.json';
    try {
      check(kickChannelCache($url) === null);
      kickChannelCache($url, '<html>challenge</html>');
      check(kickChannelCache($url) === null);
      check(!isKickChannelResponse('null', 'anyone'));
      check(!isKickChannelResponse($body, 'other'));
      kickChannelCache($url, $body);
      check(kickChannelCache($url) === $body);
      check(kickChannelCache('https://kick.com/api/v2/channels/other') === null);
      check(kickChannelCache('https://kick.com/api/v1/channels/anyone') === null);
      check(getKickChannelSlug('https://kick.com/api/v2/channels/anyone?token=1') === null);
      $entries = json_decode(file_get_contents($cache), true);
      foreach ($entries as &$entry) $entry['expires'] = time() - 1;
      unset($entry);
      file_put_contents($cache, json_encode($entries));
      check(kickChannelCache($url) === null);
      file_put_contents($cache, '{broken');
      check(kickChannelCache($url) === null);
      kickChannelCache($url, $body);
      check(kickChannelCache($url) === $body);
    } finally { if (is_file($cache)) unlink($cache); }
  `);
});

test('PHP chat operations allow only the matching platform targets and expected redirects', { skip: !available }, () => {
  runProxyTest(`
    $kick = 'https://kick.com/api/v2/channels/anyone';
    $v1 = 'https://www.kick.com/api/v1/channels/anyone';
    $youtube = 'https://www.youtube.com';
    $live = $youtube . '/@' . rawurlencode('Канал') . '/live';
    $video = 'abcdefghijk';
    check(isAllowedOperationUrl($kick, 'kick-room'));
    check(isAllowedOperationUrl($v1, 'kick-room', true));
    check(!isAllowedOperationUrl($kick . '?unexpected=1', 'kick-room'));
    check(!isAllowedOperationUrl($kick, 'youtube-live', true));
    check(isAllowedOperationUrl($live, 'youtube-live'));
    check(isAllowedOperationUrl($youtube . '/channel/UC' . str_repeat('a', 22) . '/live', 'youtube-live'));
    check(isAllowedOperationUrl($youtube . '/user/legacy/live', 'youtube-live'));
    check(!isAllowedOperationUrl($live . '?unexpected=1', 'youtube-live'));
    check(!isAllowedOperationUrl($live . '#fragment', 'youtube-live'));
    check(!isAllowedOperationUrl($youtube . '/@name%2Flive', 'youtube-live'));
    $watch = resolveRedirectUrl($live, '/watch?v=' . $video . '&feature=youtu.be');
    check(!isAllowedOperationUrl($watch, 'youtube-live'));
    check(isAllowedOperationUrl($watch, 'youtube-live', true));
    check(isAllowedOperationUrl($youtube . '/@new-handle', 'youtube-live', true));
    check(!isAllowedOperationUrl($youtube . '/watch?v=' . $video . '&unexpected=1', 'youtube-live', true));
    check(!isAllowedOperationUrl('https://twitch.tv/anything', 'youtube-live', true));
    check(!isAllowedOperationUrl('https://other.youtube.com/@name/live', 'youtube-live', true));
    $chat = $youtube . '/live_chat?';
    check(isAllowedOperationUrl($chat . 'v=' . $video . '&is_popout=1', 'youtube-chat'));
    check(isAllowedOperationUrl($chat . 'is_popout=1&continuation=example%2B%2F%3D', 'youtube-chat'));
    check(!isAllowedOperationUrl($chat . 'v=' . $video . '&v=' . $video . '&is_popout=1', 'youtube-chat'));
    check(!isAllowedOperationUrl($chat . 'v=' . $video . '&continuation=example&is_popout=1', 'youtube-chat'));
    check(!isAllowedOperationUrl($chat . 'continuation=&is_popout=1', 'youtube-chat'));
    check(!isAllowedOperationUrl($watch, 'youtube-chat', true));
    check(isAllowedUrl('https://twitch.tv/anything'));
  `);
});

test('PHP chat operations classify upstream errors and enforce a shared request deadline', { skip: !available }, () => {
  runProxyTest(`
    check(upstreamHttpError(404) === [404, 'upstream_not_found']);
    check(upstreamHttpError(429) === [429, 'upstream_rate_limited']);
    check(upstreamHttpError(403) === [502, 'upstream_blocked']);
    check(upstreamHttpError(504) === [504, 'upstream_timeout']);
    check(remainingUpstreamTimeMs(null) === REQUEST_TIMEOUT_SECONDS * 1000);
    $deadline = hrtime(true) / 1000000 + CHAT_REQUEST_TIMEOUT_MS;
    $remainingMs = remainingUpstreamTimeMs($deadline);
    check($remainingMs > 0 && $remainingMs <= 8000);
    check(remainingUpstreamTimeMs(0.0) === 0);
    if (extension_loaded('curl')) {
      $result = fetchUrl('https://www.youtube.com/@name/live', 0.0);
      check($result === ['success' => false, 'errno' => CURLE_OPERATION_TIMEDOUT]);
    }
  `);
});
