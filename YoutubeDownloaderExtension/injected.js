(function initProxyFetch() {
  const BRIDGE_SOURCE = "yt-saver-bridge";
  const REQUEST_TYPE = "YT_SAVER_PROXY_FETCH";
  const RESPONSE_TYPE = "YT_SAVER_PROXY_FETCH_RESPONSE";
  const REQUEST_TIMEOUT_MS = 15000;

  if (typeof window.proxyFetch === "function") {
    return;
  }

  const shouldSendBody = (method) => !["GET", "HEAD"].includes(method.toUpperCase());

  async function proxyFetch(input, init = {}) {
    const request = new Request(input, init);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body =
      shouldSendBody(request.method) && request.bodyUsed === false
        ? await request.clone().text()
        : undefined;

    if (shouldSendBody(request.method) && request.bodyUsed && body == null) {
      throw new Error("proxyFetch cannot reuse a consumed request body.");
    }

    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return new Promise((resolve, reject) => {
      const teardown = (handler, timer) => {
        window.removeEventListener("message", handler);
        clearTimeout(timer);
      };

      const onMessage = (event) => {
        const data = event.data;
        if (
          !data ||
          data.source !== BRIDGE_SOURCE ||
          data.type !== RESPONSE_TYPE ||
          data.id !== id
        ) {
          return;
        }

        teardown(onMessage, timeoutId);

        const payload = data.response || {};
        if (!payload.ok && payload.error) {
          reject(new Error(payload.error));
          return;
        }

        resolve(createProxyResponse(payload));
      };

      const timeoutId = window.setTimeout(() => {
        teardown(onMessage, timeoutId);
        reject(new Error("proxyFetch timed out."));
      }, REQUEST_TIMEOUT_MS);

      window.addEventListener("message", onMessage);

      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          type: REQUEST_TYPE,
          id,
          request: {
            url: request.url,
            method: request.method,
            headers,
            body,
            credentials: request.credentials || "same-origin"
          }
        },
        "*"
      );
    });
  }

  function createProxyResponse(payload) {
    const headers = new Headers(payload.headers || []);
    const bodyText = typeof payload.body === "string" ? payload.body : "";

    const response = {
      ok: Boolean(payload.ok),
      status: payload.status || 0,
      statusText: payload.statusText || "",
      headers,
      text: () => Promise.resolve(bodyText),
      json: () =>
        Promise.resolve(bodyText).then((text) => (text ? JSON.parse(text) : null)),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(bodyText).buffer)
    };

    response.blob = () =>
      response.arrayBuffer().then(
        (buf) => new Blob([buf], { type: headers.get("content-type") || "text/plain" })
      );
    response.clone = () => createProxyResponse(payload);

    return response;
  }

  Object.defineProperty(window, "proxyFetch", {
    value: proxyFetch,
    enumerable: false,
    configurable: false,
    writable: false
  });
})();


