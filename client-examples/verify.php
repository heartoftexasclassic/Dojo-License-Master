<?php
/**
 * Drop-in license verifier for PHP clients.
 *
 * Usage:
 *   require_once __DIR__ . '/verify.php';
 *   $result = dojo_verify_license();
 *   if (!$result['valid']) { /* degrade feature */ }
 *
 * Expects these env vars (or define the constants before requiring this file):
 *   LICENSE_SERVER   e.g. https://licenses.yourdomain.com
 *   LICENSE_KEY      e.g. DOJO-XXXX-XXXX-XXXX-XXXX
 *   SITE_DOMAIN      e.g. example.com
 *
 * Caches last good result in a file so a server outage doesn't take the
 * site down. Fails open for up to GRACE seconds after the last success.
 */

function dojo_verify_license($force = false) {
    $cacheFile = __DIR__ . '/.license-cache.json';
    $refresh = 60 * 60;             // 1 hour
    $grace = 7 * 24 * 60 * 60;      // 7 days

    $now = time();
    $cache = null;
    if (file_exists($cacheFile)) {
        $cache = json_decode(file_get_contents($cacheFile), true);
    }

    if (!$force && $cache && ($now - $cache['checked_at']) < $refresh) {
        return $cache['result'];
    }

    $server = getenv('LICENSE_SERVER') ?: (defined('LICENSE_SERVER') ? LICENSE_SERVER : '');
    $key    = getenv('LICENSE_KEY')    ?: (defined('LICENSE_KEY')    ? LICENSE_KEY    : '');
    $domain = getenv('SITE_DOMAIN')    ?: (defined('SITE_DOMAIN')    ? SITE_DOMAIN    : '');

    $payload = json_encode(['license_key' => $key, 'domain' => $domain]);
    $ch = curl_init(rtrim($server, '/') . '/api/verify');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_CONNECTTIMEOUT => 3,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($status === 200 && $body) {
        $result = json_decode($body, true);
        if (is_array($result)) {
            @file_put_contents($cacheFile, json_encode([
                'checked_at' => $now,
                'result'     => $result,
            ]));
            return $result;
        }
    }

    if ($cache && !empty($cache['result']['valid']) && ($now - $cache['checked_at']) < $grace) {
        $stale = $cache['result'];
        $stale['stale'] = true;
        return $stale;
    }
    return ['valid' => false, 'reason' => 'network_error'];
}
