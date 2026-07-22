/**
 * Utility functions for MultiChat
 * Includes CORS proxy fetcher with multiple fallback services
 */

async function fetchWithCorsProxy(url) {
  // If URL is known to block CORS directly (YouTube, Kick API, VK Video), skip direct fetch to prevent red console errors
  const isCorsBlockedDirectly = /youtube\.com|kick\.com|vkplay\.live|vkvideo\.ru/i.test(url);

  if (!isCorsBlockedDirectly) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (e) {
      // Direct fetch failed, fallback to proxies
    }
  }

  // List of CORS proxies
  const proxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.org/?${encodeURIComponent(u)}`
  ];

  for (const proxyFn of proxies) {
    try {
      const proxyUrl = proxyFn(url);
      const res = await fetch(proxyUrl);
      if (res && res.ok) return res;
    } catch (e) {
      // Quietly try next proxy
    }
  }

  throw new Error(`Unable to fetch ${url} via CORS proxies.`);
}
