/**
 * Utility functions for MultiChat
 * Includes CORS proxy fetcher with multiple fallback services
 */

const MULTICHAT_PROXY_URL = 'https://fra3a.ru/tools/proxy/';

function rethrowIfRequestWasAborted(init, error) {
  if (init.signal?.aborted) throw error;
}

async function fetchWithCorsProxy(url, init = {}) {
  // Skip direct fetch for CORS-restricted domains to prevent red console errors
  const isCorsBlockedDirectly = /youtube\.com|kick\.com|vkplay\.live|vkvideo\.ru/i.test(url);

  if (!isCorsBlockedDirectly) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
    } catch (e) {
      rethrowIfRequestWasAborted(init, e);
      // Direct fetch failed
    }
  }

  const encodedUrl = encodeURIComponent(url);

  // 1. Собственный прокси; публичные сервисы ниже остаются аварийными fallback-ами.
  try {
    const res = await fetch(`${MULTICHAT_PROXY_URL}?url=${encodedUrl}`, init);
    if (res && res.ok) return res;

    console.warn(`[CORS Proxy] fra3a.ru returned HTTP ${res?.status || 'error'}; trying public fallbacks.`);
  } catch (e) {
    rethrowIfRequestWasAborted(init, e);
    console.warn('[CORS Proxy] fra3a.ru is unavailable; trying public fallbacks.', e);
  }

  // 2. Corsproxy.io (быстрый и надежный публичный прокси)
  try {
    const res = await fetch(`https://corsproxy.io/?${encodedUrl}`, init);
    if (res && res.ok) return res;
  } catch (e) {
    rethrowIfRequestWasAborted(init, e);
  }

  // 3. AllOrigins JSON Endpoint (/get) - возвращает 200 OK с { contents: "..." }
  try {
    const res = await fetch(`https://api.allorigins.win/get?url=${encodedUrl}`, init);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.contents === 'string' && data.contents.length > 0) {
        return new Response(data.contents, {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
  } catch (e) {
    rethrowIfRequestWasAborted(init, e);
  }

  // 4. AllOrigins Raw Endpoint
  try {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodedUrl}`, init);
    if (res && res.ok) return res;
  } catch (e) {
    rethrowIfRequestWasAborted(init, e);
  }

  // 5. Codetabs proxy fallback
  try {
    const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`, init);
    if (res && res.ok) return res;
  } catch (e) {
    rethrowIfRequestWasAborted(init, e);
  }

  throw new Error(`Unable to fetch ${url} via CORS proxies.`);
}
