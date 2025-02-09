// Background initialization
import { handleAuth } from './auth_handler.js';
import { handleActionWebsocket } from './websocket_utils.js';
import { generateUUID } from '../utils.js';
import { cleanup } from './cleanup.js';

// Add localization support
function _t(text, ...args) {
  try {
    return chrome.i18n ? chrome.i18n.getMessage(text, args) || text : text;
  } catch (e) {
    return text;
  }
}

// Add service worker activation logging
const debug = (...args) => {
  const timestamp = new Date().toISOString();
  console.log(`[Copilot Background Init ${timestamp}]`, ...args);
  console.trace();
};

debug('Service worker initialization starting');

// Initialize offscreen document manager
let offscreenHandle;

async function setupOffscreenDocument(path) {
  debug('Setting up offscreen document:', path);
  if (offscreenHandle) {
    debug('Offscreen document already exists');
    return;
  }

  try {
    offscreenHandle = await chrome.offscreen.createDocument({
      url: path,
      reasons: ['WEBSOCKET'],
      justification: 'Managing WebSocket connections'
    });
    debug('Created offscreen document');
  } catch (error) {
    debug('Error creating offscreen document:', error);
    console.error(error); // Full error log
    throw error;
  }
}

// Add global message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debug('Received message:', { 
    action: message.action, 
    senderId: sender.id,
    tabId: sender.tab?.id,
    frameId: sender.frameId
  });

  // Handle different message types
  switch (message.action) {
    case 'copilot-auth':
      debug('Handling auth request');
      return handleAuth(message, sender, sendResponse);
      
    case 'setup-offscreen':
      debug('Handling setup-offscreen request');
      setupOffscreenDocument('https://copilot.microsoft.com/favicon.ico?copilot-chat')
        .then(() => {
          debug('Setup complete');
          sendResponse(true);
        })
        .catch((error) => {
          debug('Setup failed:', error);
          sendResponse(false);
        });
      return true;

    case 'socket':
      debug('Handling socket request');
      handleActionWebsocket(message)
        .then(response => {
          debug('Socket action completed');
          sendResponse(response);
        })
        .catch(error => {
          debug('Socket action failed:', error);
          sendResponse({ error: error.toString() });
        });
      return true;
  }
});

// Listen for extension install/update
chrome.runtime.onInstalled.addListener((details) => {
  debug('Extension installed/updated:', details.reason);
  cleanup().then(() => {
    debug('Cleanup complete after install/update');
  });
});

// Listen for extension startup
chrome.runtime.onStartup.addListener(() => {
  debug('Extension starting up');
  cleanup().then(() => {
    debug('Cleanup complete after startup');
  });
});

debug('Service worker initialization complete');

// Export utilities
export { debug, setupOffscreenDocument, _t };