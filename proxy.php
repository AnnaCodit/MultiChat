<?php

declare(strict_types=1);

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

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
];

header('X-Multichat-Proxy: generic');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; sandbox");
header('Cache-Control: no-store');
header('Content-Type: text/plain; charset=utf-8');

function fail(int $status, string $publicMessage, string $logMessage = ''): void
{
    http_response_code($status);

    if ($logMessage !== '') {
        $safeLogMessage = str_replace(["\r", "\n"], ['\\r', '\\n'], $logMessage);
        error_log('[Proxy] ' . $safeLogMessage);
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

    // YouTube otherwise redirects server-side clients to consent.youtube.com.
    if (hostMatchesSuffix($host, 'youtube.com')) {
        $headers[] = 'Cookie: SOCS=CAI';
    }

    return $headers;
}

function fetchUrl(string $url): array
{
    $body = '';
    $location = null;
    $contentType = '';
    $tooLarge = false;
    $curl = curl_init($url);

    if ($curl === false) {
        return ['error' => 'Unable to initialize cURL'];
    }

    curl_setopt_array($curl, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
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

    $success = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);

    return [
        'success' => $success !== false,
        'status' => $status,
        'location' => $location,
        'contentType' => $contentType,
        'body' => $body,
        'tooLarge' => $tooLarge,
        'error' => $error,
    ];
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
    fail(400, 'The target URL is not allowed.', 'Rejected URL: ' . $url);
}

$currentUrl = $url;

for ($redirectCount = 0; $redirectCount <= MAX_REDIRECTS; $redirectCount++) {
    $result = fetchUrl($currentUrl);

    if (($result['tooLarge'] ?? false) === true) {
        fail(502, 'The upstream response is too large.', 'Response exceeded the size limit for ' . $currentUrl);
    }

    if (($result['success'] ?? false) !== true) {
        fail(502, 'Unable to fetch the target URL.', 'cURL failed for ' . $currentUrl . ': ' . ($result['error'] ?? 'unknown error'));
    }

    $status = $result['status'];
    $location = $result['location'];
    if (in_array($status, [301, 302, 303, 307, 308], true) && is_string($location)) {
        $redirectUrl = resolveRedirectUrl($currentUrl, $location);
        if ($redirectUrl === null || !isAllowedUrl($redirectUrl)) {
            fail(502, 'The upstream server returned an unsupported redirect.', 'Rejected redirect from ' . $currentUrl . ' to ' . $location);
        }

        $currentUrl = $redirectUrl;
        continue;
    }

    if ($status < 200 || $status >= 300) {
        fail(502, 'The upstream server returned HTTP ' . $status . '.', 'Upstream HTTP ' . $status . ' for ' . $currentUrl);
    }

    if (preg_match('~^application/(?:[a-z0-9.+-]+\\+)?json\\b~i', $result['contentType']) === 1) {
        header('Content-Type: application/json; charset=utf-8');
    }

    echo $result['body'];
    exit;
}

fail(502, 'The upstream server returned too many redirects.', 'Redirect limit exceeded for ' . $url);
