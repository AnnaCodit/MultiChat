<?php

declare(strict_types=1);

// Copy this file to settings.php, fill in the purchased proxy credentials,
// and upload it next to index.php. A direct web request receives no config data.
if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(404);
    exit;
}

return [
    // Supported values: http, socks5, socks5h. Prefer socks5h when available.
    'type' => 'socks5h',
    'host' => 'proxy.example.com',
    'port' => 1080,
    'username' => 'replace-me',
    'password' => 'replace-me',
];
