/**
 * Overview:
 * This script handles incoming messages from the parent window to perform network requests
 * to Microsoft Copilot endpoints or forward actions to a WebSocket handler.
 */

// Signal to the parent window that the socket script has been loaded and is ready.
window.parent.postMessage('socket-script-ready', '*');

// Listen for messages from the parent window.
window.addEventListener('message', async (event) => {
  window.parent.postMessage({
    message: await handleMessage(event.data.message),
    messageId: event.data.messageId,
  }, '*');
});

/**
 * Processes an incoming message based on its action type.
 * @param {Object} message - The message object containing an action and other relevant data.
 * @returns {Promise<Object>} - The response from the network request or WebSocket handler.
 */
async function handleMessage(message) {
  switch (message.action) {
    case 'session':
      // Handle session requests through background script
      throw new Error('Session requests should go through background script');
      
    default:
      // For websocket connections to Copilot
      if (message.url?.includes('wss://copilot.microsoft.com')) {
        message.headers = {
          'Origin': 'https://copilot.microsoft.com',
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'User-Agent': navigator.userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-WebSocket-Protocol': 'chat',
          'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
        };
      }
      return handleActionWebsocket(message);
  }
}
