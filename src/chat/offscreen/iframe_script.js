/**
 * Script running in the iframe that has the correct origin.
 */

(() => {
  const debug = (...args) => console.log('[Copilot Iframe]', ...args);
  
  // Track the last time we received a response
  let lastResponseTime = Date.now();
  
  // Setup ping interval for keepalive
  setInterval(() => {
    if (Date.now() - lastResponseTime > 30000) {
      debug('No response for 30s, reconnecting iframe');
      window.location.reload();
    }
  }, 15000);

  window.parent.postMessage('iframe-script-ready', '*');

  window.addEventListener('message', onReceiveMessageFromParent);

  function onReceiveMessageFromParent(event) {
    const expectedOrigin = new URL(chrome.runtime.getURL("")).origin;
    if (event.origin !== expectedOrigin) {
      debug('Ignoring message from unexpected origin:', event.origin);
      return;
    }

    const data = event.data;
    if (!('scripts' in data)) return;

    data.scripts.forEach(insertScript);
    acknowledge(data.messageId, data.scriptElementId);
    lastResponseTime = Date.now();
  }

  function acknowledge(messageId, scriptElementId) {
    window.parent.postMessage({
      message: `Script "${scriptElementId}" successfully injected`,
      messageId: messageId,
      timestamp: Date.now()
    }, '*');
  }

  function insertScript(src) {
    debug('Inserting script:', src);
    const scriptElement = document.createElement('script');
    scriptElement.type = 'text/javascript';
    scriptElement.src = src;
    scriptElement.onerror = (error) => {
      debug('Script load error:', error);
      window.parent.postMessage({
        error: 'Script load failed: ' + src,
        timestamp: Date.now()
      }, '*');
    };
    scriptElement.onload = () => {
      debug('Script loaded:', src);
      lastResponseTime = Date.now();
    };
    document.body.appendChild(scriptElement);
  }

  // Add proper security headers via meta tags
  const metaHeaders = {
    'Content-Security-Policy': "default-src 'self' https://copilot.microsoft.com; connect-src wss://copilot.microsoft.com https://copilot.microsoft.com; script-src 'self' 'unsafe-inline';",
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff'
  };

  Object.entries(metaHeaders).forEach(([name, content]) => {
    const meta = document.createElement('meta');
    meta.httpEquiv = name;
    meta.content = content;
    document.head.appendChild(meta);
  });

})();