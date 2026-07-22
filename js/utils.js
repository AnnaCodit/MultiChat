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

  // 1. AllOrigins JSON Endpoint (/get) returns HTTP 200 with { contents: "..." }, preventing red CORS/520 console errors
  try {
    const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.contents === 'string') {
        return new Response(data.contents, {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
  } catch (e) {}

  // 2. Codetabs proxy fallback
  try {
    const res = await fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`);
    if (res && res.ok) return res;
  } catch (e) {}

  throw new Error(`Unable to fetch ${url} via CORS proxies.`);
}
