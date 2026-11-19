/**
 * Utility functions for MultiChat
 * Includes CORS proxy fetcher with multiple fallback services
 */

const MULTICHAT_PROXY_URL = 'https://fra3a.ru/tools/proxy/';

function rethrowIfRequestWasAborted(init, error) {
  if (init.signal?.aborted) throw error;
}

async function fetchWithCorsProxy(url, init = {}, options = {}) {
  const { operation, refresh, readResponse = response => response } = options;
  // Skip direct fetch for CORS-restricted domains to prevent red console errors
  const isCorsBlockedDirectly = /youtube\.com|kick\.com|vkplay\.live|vkvideo\.ru/i.test(url);

  if (!isCorsBlockedDirectly) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return await readResponse(res);
    } catch (e) {
      rethrowIfRequestWasAborted(init, e);
      // Direct fetch failed
    }
  }

  const encodedUrl = encodeURIComponent(url);
  const primaryQuery = operation ? new URLSearchParams({ url, operation }) : `url=${encodedUrl}`;
  if (operation && refresh) primaryQuery.set('refresh', '1');

  // 1. Собственный прокси; публичные сервисы ниже остаются аварийными fallback-ами.
  let primaryError;
  const primary = async requestInit => {
    let response;
    try {
      response = await fetch(`${MULTICHAT_PROXY_URL}?${primaryQuery}`, requestInit);
      if (response?.ok) return await readResponse(response);
      throw new Error('Own proxy returned an HTTP error');
    } catch (error) {
      rethrowIfRequestWasAborted(requestInit, error);
      const requestId = response?.headers?.get('X-Multichat-Request-Id');
      const errorCode = response?.headers?.get('X-Multichat-Error');
      primaryError = Object.assign(new Error('Own proxy request failed', { cause: error }), {
        status: response?.status,
        code: error?.code,
        requestId: /^[a-z\d-]{1,80}$/i.test(requestId || '') ? requestId : undefined,
        proxyCode: /^[a-z_]{1,50}$/.test(errorCode || '') ? errorCode : undefined
      });
      console.warn('[CORS Proxy] Own route failed; trying public fallbacks.', {
        operation, status: primaryError.status, code: primaryError.proxyCode || primaryError.code,
        requestId: primaryError.requestId
      });
      throw primaryError;
    }
  };

  const fallbacks = [
    // 2. Corsproxy.io (публичный прокси)
    [`https://corsproxy.io/?${encodedUrl}`],
    // 3. AllOrigins JSON Endpoint (/get) - возвращает 200 OK с { contents: "..." }
    [`https://api.allorigins.win/get?url=${encodedUrl}`, true],
    // 4. AllOrigins Raw Endpoint
    [`https://api.allorigins.win/raw?url=${encodedUrl}`],
    // 5. Codetabs proxy fallback
    [`https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`]
  ].map(([proxyUrl, wrapped]) => async requestInit => {
    let response = await fetch(proxyUrl, requestInit);
    if (!response?.ok) throw new Error('Public proxy returned an HTTP error');
    if (wrapped) {
      const data = await response.json();
      if (typeof data?.contents !== 'string' || !data.contents) throw new Error('Public proxy returned an empty response');
      response = new Response(data.contents, { headers: { 'Content-Type': 'text/html' } });
    }
    return readResponse(response);
  });

  const attempts = [primary, ...fallbacks];
  if (operation && typeof AbortSignal.any === 'function') {
    try {
      return await fetchFirstValidProxy(attempts, init);
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
    }
  } else {
    for (const attempt of attempts) {
      try {
        return await attempt(init);
      } catch (error) {
        rethrowIfRequestWasAborted(init, error);
      }
    }
  }

  throw new Error('Unable to fetch via CORS proxies.', { cause: primaryError });
}

async function fetchFirstValidProxy(attempts, init) {
  const controllers = attempts.map(() => new AbortController());
  let winner = -1;
  let start = Promise.resolve();
  const requests = attempts.map((attempt, index) => {
    const controller = controllers[index];
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const request = start.then(async () => {
      signal.throwIfAborted();
      const data = await attempt({ ...init, signal });
      signal.throwIfAborted();
      if (winner === -1) winner = index;
      return data;
    });

    if (index < attempts.length - 1) {
      // Let a slow route finish within the connector's deadline while trying the next one.
      start = start.then(() => {
        let timer;
        const delay = new Promise(resolve => { timer = setTimeout(resolve, index === 0 ? 10000 : 4000); });
        return Promise.race([request.catch(() => {}), delay]).finally(() => clearTimeout(timer));
      });
    }
    return request;
  });

  try {
    return await Promise.any(requests);
  } finally {
    controllers.forEach((controller, index) => {
      if (index !== winner) controller.abort();
    });
  }
}
