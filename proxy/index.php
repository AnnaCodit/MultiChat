<?php

declare(strict_types=1);

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_SECONDS = 7;
const REQUEST_TIMEOUT_SECONDS = 25;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const PROXY_LOG_FILE = __DIR__ . '/proxy.log';
const UPSTREAM_PROXY_CONFIG_FILE = __DIR__ . '/proxy.settings.php';

// Browser origins allowed to use the deployed proxy. Origin never includes a URL path.
const ALLOWED_ORIGINS = [
    'http://localhost:8088',
    'http://127.0.0.1:8088',
    'https://annacodit.github.io',
    'https://fra3a.ru',
    'https://www.fra3a.ru',
];

// Add a trusted domain suffix here when a new platform needs server-side fetching.
const ALLOWED_HOST_SUFFIXES = [
    'youtube.com',
    'twitch.tv',
    'kick.com',
    'vkvideo.ru',
    'vkplay.live',
    '7tv.app',
    '7tv.io',
    'betterttv.net',
    'frankerfacez.com',
    'ivr.fi',
    'decapi.me',
    'twitchtracker.com',
];

// Cache only validated Kick channel metadata; keep runtime data outside the web root.
const KICK_CACHE_TTL_SECONDS = 900;
const MAX_KICK_CACHE_BYTES = 5 * 1024 * 1024;

header_remove('X-Powered-By');
header('X-Multichat-Proxy: generic');
header('X-Multichat-Request-Id: ' . requestId());
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; sandbox");
header('Cache-Control: no-store');
header('Content-Type: text/plain; charset=utf-8');

function requestId(): string
{
    static $requestId = null;

    if ($requestId === null) {
        try {
            $requestId = bin2hex(random_bytes(8));
        } catch (Throwable $error) {
            $requestId = str_replace('.', '', uniqid('', true));
        }
    }

    return $requestId;
}

function logProxy(string $message): void
{
    $safeMessage = str_replace(["\r", "\n"], ['\\r', '\\n'], $message);
    $line = sprintf("%s [Proxy][%s] %s\n", gmdate('c'), requestId(), $safeMessage);
    $handle = @fopen(PROXY_LOG_FILE, 'c+');

    if ($handle === false) {
        header('X-Multichat-Log-Status: unavailable');
        return;
    }

    if (@flock($handle, LOCK_EX)) {
        $stat = fstat($handle);
        if (is_array($stat) && ($stat['size'] ?? 0) >= MAX_LOG_BYTES) {
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, gmdate('c') . " [Proxy] Log truncated after reaching 5 MiB.\n");
        }

        fseek($handle, 0, SEEK_END);
        fwrite($handle, $line);
        fflush($handle);
        flock($handle, LOCK_UN);
        header('X-Multichat-Log-Status: proxy.log');
    } else {
        header('X-Multichat-Log-Status: unavailable');
    }

    fclose($handle);
}

function urlForLog(string $url): string
{
    $parts = parse_url($url);
    if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
        return '[invalid or relative URL]';
    }

    $description = strtolower((string) $parts['scheme'])
        . '://'
        . strtolower((string) $parts['host']);

    if (isset($parts['port'])) {
        $description .= ':' . (int) $parts['port'];
    }

    $description .= isset($parts['path']) && $parts['path'] !== ''
        ? (string) $parts['path']
        : '/';

    if (isset($parts['query'])) {
        $description .= '?[redacted]';
    }

    return $description;
}

function getUpstreamProxyConfig(): ?array
{
    static $configLoaded = false;
    static $config = null;

    if ($configLoaded) {
        return $config;
    }

    $configLoaded = true;
    $values = [
        'type' => getenv('MULTICHAT_UPSTREAM_PROXY_TYPE') ?: '',
        'host' => getenv('MULTICHAT_UPSTREAM_PROXY_HOST') ?: '',
        'port' => getenv('MULTICHAT_UPSTREAM_PROXY_PORT') ?: '',
        'username' => getenv('MULTICHAT_UPSTREAM_PROXY_USERNAME') ?: '',
        'password' => getenv('MULTICHAT_UPSTREAM_PROXY_PASSWORD') ?: '',
    ];

    if (is_file(UPSTREAM_PROXY_CONFIG_FILE)) {
        $localValues = require UPSTREAM_PROXY_CONFIG_FILE;
        if (!is_array($localValues)) {
            fail(500, 'The upstream proxy configuration is invalid.', 'proxy.settings.php must return an array.');
        }

        $values = array_merge($values, $localValues);
    }

    $type = strtolower(trim((string) ($values['type'] ?? '')));
    $host = trim((string) ($values['host'] ?? ''));
    $port = filter_var($values['port'] ?? null, FILTER_VALIDATE_INT, [
        'options' => ['min_range' => 1, 'max_range' => 65535],
    ]);

    if ($type === '' && $host === '' && ($values['port'] ?? '') === '') {
        return null;
    }

    $proxyTypes = [
        'http' => CURLPROXY_HTTP,
        'socks5' => CURLPROXY_SOCKS5,
        // socks5h resolves target hostnames through the proxy and is preferred
        // when the hosting provider also filters or breaks DNS for YouTube.
        'socks5h' => CURLPROXY_SOCKS5_HOSTNAME,
    ];

    if (!isset($proxyTypes[$type])) {
        fail(500, 'The upstream proxy configuration is invalid.', 'Unsupported upstream proxy type: ' . $type);
    }

    if ($host === '' || preg_match('~[\s/@]~', $host) === 1 || $port === false) {
        fail(500, 'The upstream proxy configuration is invalid.', 'Invalid upstream proxy host or port.');
    }

    $config = [
        'type' => $type,
        'curlType' => $proxyTypes[$type],
        'host' => $host,
        'port' => (int) $port,
        'username' => (string) ($values['username'] ?? ''),
        'password' => (string) ($values['password'] ?? ''),
    ];

    return $config;
}

function shouldUseUpstreamProxy(string $url): bool
{
    $host = (string) (parse_url($url, PHP_URL_HOST) ?? '');
    return hostMatchesSuffix($host, 'youtube.com')
        || hostMatchesSuffix($host, 'kick.com');
}

function applyUpstreamProxy($curl, string $url): ?array
{
    if (!shouldUseUpstreamProxy($url)) {
        return null;
    }

    $config = getUpstreamProxyConfig();
    if ($config === null) {
        return null;
    }

    $options = [
        CURLOPT_PROXY => $config['host'],
        CURLOPT_PROXYPORT => $config['port'],
        CURLOPT_PROXYTYPE => $config['curlType'],
    ];

    if ($config['type'] === 'http') {
        // HTTPS targets travel through an HTTP CONNECT tunnel; TLS verification
        // below still validates YouTube itself end-to-end.
        $options[CURLOPT_HTTPPROXYTUNNEL] = true;
    }

    if ($config['username'] !== '' || $config['password'] !== '') {
        $options[CURLOPT_PROXYUSERPWD] = $config['username'] . ':' . $config['password'];
    }

    curl_setopt_array($curl, $options);
    return $config;
}

function fail(int $status, string $publicMessage, string $logMessage = ''): void
{
    http_response_code($status);

    if ($logMessage !== '') {
        logProxy($logMessage);
    }

    echo $publicMessage;
    exit;
}

function applyCorsHeaders(): void
{
    $origin = isset($_SERVER['HTTP_ORIGIN']) && is_string($_SERVER['HTTP_ORIGIN'])
        ? $_SERVER['HTTP_ORIGIN']
        : '';

    // Same-origin browser requests usually omit Origin. CORS is only needed when it is present.
    if ($origin === '') {
        return;
    }

    if (!in_array($origin, ALLOWED_ORIGINS, true)) {
        fail(403, 'This origin is not allowed.', 'Rejected origin: ' . $origin);
    }

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, Content-Type');
    header('Access-Control-Expose-Headers: X-Multichat-Proxy, X-Multichat-Request-Id, X-Multichat-Log-Status');
    header('Access-Control-Max-Age: 86400');
    header('Vary: Origin');
}

function hostMatchesSuffix(string $host, string $suffix): bool
{
    $host = strtolower($host);
    $suffix = strtolower($suffix);

    return $host === $suffix
        || substr($host, -strlen('.' . $suffix)) === '.' . $suffix;
}

function isAllowedHost(string $host): bool
{
    foreach (ALLOWED_HOST_SUFFIXES as $suffix) {
        if (hostMatchesSuffix($host, $suffix)) {
            return true;
        }
    }

    return false;
}

function isAllowedUrl(string $url): bool
{
    $parts = parse_url($url);
    if ($parts === false || ($parts['scheme'] ?? '') !== 'https' || !isset($parts['host'])) {
        return false;
    }

    if (isset($parts['user']) || isset($parts['pass'])) {
        return false;
    }

    return isAllowedHost($parts['host'])
        && (!isset($parts['port']) || $parts['port'] === 443);
}

function resolveRedirectUrl(string $baseUrl, string $location): ?string
{
    $location = trim($location);
    if ($location === '') {
        return null;
    }

    if (preg_match('~^https?://~i', $location) === 1) {
        return $location;
    }

    $base = parse_url($baseUrl);
    if ($base === false || !isset($base['scheme'], $base['host'])) {
        return null;
    }

    if (strpos($location, '//') === 0) {
        return $base['scheme'] . ':' . $location;
    }

    if (strpos($location, '/') !== 0) {
        return null;
    }

    return $base['scheme'] . '://' . $base['host'] . $location;
}

function getUpstreamHeaders(string $url): array
{
    $headers = [
        'Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language: ru-RU,ru;q=0.9,en;q=0.8',
    ];
    $host = (string) (parse_url($url, PHP_URL_HOST) ?? '');

    // YouTube otherwise may redirect server-side clients to consent.youtube.com.
    if (hostMatchesSuffix($host, 'youtube.com')) {
        $headers[] = 'Cookie: SOCS=CAI; CONSENT=YES+cb';
    }

    return $headers;
}

function fetchUrlOnce(string $url, int $ipResolve): array
{
    $body = '';
    $location = null;
    $contentType = '';
    $tooLarge = false;
    $curl = curl_init($url);

    if ($curl === false) {
        return [
            'success' => false,
            'error' => 'Unable to initialize cURL',
            'errno' => -1,
        ];
    }

    curl_setopt_array($curl, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT_SECONDS,
        CURLOPT_TIMEOUT => REQUEST_TIMEOUT_SECONDS,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_ENCODING => '',
        CURLOPT_IPRESOLVE => $ipResolve,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => getUpstreamHeaders($url),
        CURLOPT_HEADERFUNCTION => static function ($curlHandle, string $header) use (&$location, &$contentType): int {
            if (stripos($header, 'Location:') === 0) {
                $location = trim(substr($header, strlen('Location:')));
            } elseif (stripos($header, 'Content-Type:') === 0) {
                $contentType = trim(substr($header, strlen('Content-Type:')));
            }

            return strlen($header);
        },
        CURLOPT_WRITEFUNCTION => static function ($curlHandle, string $chunk) use (&$body, &$tooLarge): int {
            if (strlen($body) + strlen($chunk) > MAX_RESPONSE_BYTES) {
                $tooLarge = true;
                return 0;
            }

            $body .= $chunk;
            return strlen($chunk);
        },
    ]);
    $upstreamProxy = applyUpstreamProxy($curl, $url);

    $startedAt = microtime(true);
    $success = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $primaryIp = (string) curl_getinfo($curl, CURLINFO_PRIMARY_IP);
    $errorNumber = curl_errno($curl);
    $error = curl_error($curl);
    $durationMs = (int) round((microtime(true) - $startedAt) * 1000);
    curl_close($curl);

    return [
        'success' => $success !== false,
        'status' => $status,
        'location' => $location,
        'contentType' => $contentType,
        'body' => $body,
        'tooLarge' => $tooLarge,
        'error' => $error,
        'errno' => $errorNumber,
        'primaryIp' => $primaryIp,
        'durationMs' => $durationMs,
        'ipResolve' => $ipResolve,
        'upstreamProxyType' => $upstreamProxy['type'] ?? null,
    ];
}

function isRetryableNetworkFailure(array $result): bool
{
    if (($result['success'] ?? false) === true || ($result['tooLarge'] ?? false) === true) {
        return false;
    }

    return in_array((int) ($result['errno'] ?? 0), [
        CURLE_COULDNT_RESOLVE_HOST,
        CURLE_COULDNT_CONNECT,
        CURLE_OPERATION_TIMEDOUT,
        CURLE_SSL_CONNECT_ERROR,
    ], true);
}

function fetchUrl(string $url): array
{
    // Shared hosting commonly advertises unusable IPv6. Try IPv4 first, then
    // IPv6 only for connection-level failures so HTTP errors are not duplicated.
    $result = fetchUrlOnce($url, CURL_IPRESOLVE_V4);
    if (!isRetryableNetworkFailure($result)) {
        return $result;
    }

    logProxy(sprintf(
        'IPv4 request failed for %s%s (cURL %d: %s, %d ms); trying IPv6.',
        urlForLog($url),
        isset($result['upstreamProxyType']) ? ' via upstream ' . $result['upstreamProxyType'] : '',
        (int) ($result['errno'] ?? 0),
        (string) ($result['error'] ?? 'unknown error'),
        (int) ($result['durationMs'] ?? 0)
    ));

    return fetchUrlOnce($url, CURL_IPRESOLVE_V6);
}

function getKickChannelSlug(string $url): ?string
{
    $parts = parse_url($url);
    $host = strtolower((string) ($parts['host'] ?? ''));
    if (!in_array($host, ['kick.com', 'www.kick.com'], true) || isset($parts['query'])) {
        return null;
    }
    if (preg_match('~^/api/v[12]/channels/([a-zA-Z0-9_-]+)/?$~', (string) ($parts['path'] ?? ''), $matches) !== 1) {
        return null;
    }
    return strtolower($matches[1]);
}

function isKickChannelResponse(string $body, string $slug): bool
{
    $data = json_decode($body, true);
    $id = $data['chatroom']['id'] ?? null;
    return is_array($data)
        && is_string($data['slug'] ?? null)
        && strtolower($data['slug']) === $slug
        && (is_int($id) || is_string($id))
        && preg_match('/^[1-9][0-9]*$/', (string) $id) === 1;
}

function kickChannelCache(string $url, ?string $body = null): ?string
{
    $slug = getKickChannelSlug($url);
    if ($slug === null) return null;
    if ($body !== null && (!isKickChannelResponse($body, $slug) || strlen($body) > 256 * 1024)) return null;

    $path = sys_get_temp_dir() . '/multichat-kick-' . sha1(__DIR__) . '.json';
    $handle = @fopen($path, 'c+');
    if ($handle === false) {
        logProxy('Kick metadata cache unavailable.');
        return null;
    }
    try {
        if (!flock($handle, LOCK_EX)) {
            logProxy('Unable to lock Kick metadata cache.');
            return null;
        }
        $raw = stream_get_contents($handle, MAX_KICK_CACHE_BYTES + 1);
        $entries = is_string($raw) && strlen($raw) <= MAX_KICK_CACHE_BYTES ? json_decode($raw, true) : null;
        if (!is_array($entries)) $entries = [];
        $now = time();
        foreach ($entries as $key => $entry) {
            if (!is_array($entry) || !is_int($entry['expires'] ?? null) || $entry['expires'] <= $now) {
                unset($entries[$key]);
            }
        }
        // v1 and v2 payloads differ: do not share their cached response bodies.
        $key = hash('sha256', $url);
        if ($body === null) {
            $cached = $entries[$key]['body'] ?? null;
            return is_string($cached) && isKickChannelResponse($cached, $slug) ? $cached : null;
        }
        unset($entries[$key]);
        $entries[$key] = ['expires' => $now + KICK_CACHE_TTL_SECONDS, 'body' => $body];
        while (count($entries) > 200) array_shift($entries);
        $encoded = json_encode($entries, JSON_UNESCAPED_SLASHES);
        while (is_string($encoded) && strlen($encoded) > MAX_KICK_CACHE_BYTES) {
            array_shift($entries);
            $encoded = json_encode($entries, JSON_UNESCAPED_SLASHES);
        }
        if (is_string($encoded)) {
            rewind($handle);
            if (!ftruncate($handle, 0) || fwrite($handle, $encoded) !== strlen($encoded) || !fflush($handle)) {
                logProxy('Unable to write Kick metadata cache.');
            }
        }
        return null;
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

applyCorsHeaders();

$requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($requestMethod === 'OPTIONS') {
    header('Allow: GET, OPTIONS');
    http_response_code(204);
    exit;
}

if ($requestMethod !== 'GET') {
    header('Allow: GET, OPTIONS');
    fail(405, 'Only GET requests are supported.');
}

if (!function_exists('curl_init')) {
    fail(500, 'PHP cURL extension is required.', 'The cURL extension is not installed.');
}

$url = isset($_GET['url']) && is_string($_GET['url']) ? trim($_GET['url']) : '';
if ($url === '' || !isAllowedUrl($url)) {
    fail(400, 'The target URL is not allowed.', 'Rejected URL: ' . urlForLog($url));
}

$cachedKickChannel = kickChannelCache($url);
if ($cachedKickChannel !== null) {
    header('X-Multichat-Proxy: kick-cache');
    header('Content-Type: application/json; charset=utf-8');
    echo $cachedKickChannel;
    exit;
}

$currentUrl = $url;

for ($redirectCount = 0; $redirectCount <= MAX_REDIRECTS; $redirectCount++) {
    $result = fetchUrl($currentUrl);

    if (($result['tooLarge'] ?? false) === true) {
        fail(502, 'The upstream response is too large.', 'Response exceeded the size limit for ' . $currentUrl);
    }

    if (($result['success'] ?? false) !== true) {
        fail(502, 'Unable to fetch the target URL.', sprintf(
            'cURL failed for %s%s using IP mode %d (cURL %d: %s, IP: %s, %d ms)',
            urlForLog($currentUrl),
            isset($result['upstreamProxyType']) ? ' via upstream ' . $result['upstreamProxyType'] : '',
            (int) ($result['ipResolve'] ?? 0),
            (int) ($result['errno'] ?? 0),
            (string) ($result['error'] ?? 'unknown error'),
            (string) ($result['primaryIp'] ?? 'none'),
            (int) ($result['durationMs'] ?? 0)
        ));
    }

    $status = (int) ($result['status'] ?? 0);
    $location = $result['location'] ?? null;
    if (in_array($status, [301, 302, 303, 307, 308], true) && is_string($location)) {
        $redirectUrl = resolveRedirectUrl($currentUrl, $location);
        if ($redirectUrl === null || !isAllowedUrl($redirectUrl)) {
            fail(502, 'The upstream server returned an unsupported redirect.', 'Rejected redirect from ' . urlForLog($currentUrl) . ' to ' . urlForLog($location));
        }

        $currentUrl = $redirectUrl;
        continue;
    }

    if ($status < 200 || $status >= 300) {
        fail(502, 'The upstream server returned HTTP ' . $status . '.', sprintf(
            'Upstream HTTP %d for %s (IP: %s, %d ms)',
            $status,
            urlForLog($currentUrl),
            (string) ($result['primaryIp'] ?? 'none'),
            (int) ($result['durationMs'] ?? 0)
        ));
    }

    if (preg_match('~^application/(?:[a-z0-9.+-]+\\+)?json\\b~i', (string) ($result['contentType'] ?? '')) === 1) {
        header('Content-Type: application/json; charset=utf-8');
    }

    if (isset($result['upstreamProxyType'])) {
        header('X-Multichat-Proxy: upstream-' . $result['upstreamProxyType']);
    }

    $body = (string) ($result['body'] ?? '');
    $kickSlug = getKickChannelSlug($url);
    if ($kickSlug !== null) {
        if (!isKickChannelResponse($body, $kickSlug)) {
            fail(502, 'Kick returned an invalid channel response.', 'Invalid Kick metadata for ' . $kickSlug);
        }
        kickChannelCache($url, $body);
        logProxy('Resolved Kick channel: ' . $kickSlug);
    }
    echo $body;
    exit;
}

fail(502, 'The upstream server returned too many redirects.', 'Redirect limit exceeded for ' . urlForLog($url));
