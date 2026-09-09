const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const windowsPhp = 'C:/laragon/bin/php/php-8.4.5-nts-Win32-vs17-x64/php.exe';
const php = process.env.PHP_BINARY || (fs.existsSync(windowsPhp) ? windowsPhp : 'php');
const available = spawnSync(php, ['-v']).status === 0;

test('PHP routes Kick through upstream and caches only valid channel responses', { skip: !available }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichat-kick-test-'));
  try {
    // Load production functions without running the HTTP entry point or reading secrets.
    const source = fs.readFileSync(path.join(__dirname, '../proxy/index.php'), 'utf8');
    fs.writeFileSync(path.join(dir, 'functions.php'), source.split('\napplyCorsHeaders();')[0]);
    const script = `
      require 'functions.php';
      function check($condition) { if (!$condition) throw new RuntimeException('Proxy assertion failed'); }
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
        echo 'OK';
      } finally { if (is_file($cache)) unlink($cache); }
    `;
    fs.writeFileSync(path.join(dir, 'test.php'), '<?php\n' + script);
    const result = spawnSync(php, ['test.php'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, 'OK');
  } finally {
    // mkdtemp creates this isolated test directory under the OS temp directory.
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
