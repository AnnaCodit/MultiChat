/**
 * Utility functions for MultiChat
 * Includes CORS proxy fetcher with multiple fallback services
 */

async function fetchWithCorsProxy(url) {
  // Skip direct fetch for CORS-restricted domains to prevent red console errors
  const isCorsBlockedDirectly = /youtube\.com|kick\.com|vkplay\.live|vkvideo\.ru/i.test(url);

  if (!isCorsBlockedDirectly) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (e) {
      // Direct fetch failed
    }
  }

  const encodedUrl = encodeURIComponent(url);

  // 1. Corsproxy.io (быстрый и надежный публичный прокси)
  try {
    const res = await fetch(`https://corsproxy.io/?${encodedUrl}`);
    if (res && res.ok) return res;
  } catch (e) {}

  // 2. AllOrigins JSON Endpoint (/get) - возвращает 200 OK с { contents: "..." }
  try {
    const res = await fetch(`https://api.allorigins.win/get?url=${encodedUrl}`);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.contents === 'string' && data.contents.length > 0) {
        return new Response(data.contents, {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
  } catch (e) {}

  // 3. AllOrigins Raw Endpoint
  try {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodedUrl}`);
    if (res && res.ok) return res;
  } catch (e) {}

  // 4. Codetabs proxy fallback
  try {
    const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`);
    if (res && res.ok) return res;
  } catch (e) {}

  throw new Error(`Unable to fetch ${url} via CORS proxies.`);
}
