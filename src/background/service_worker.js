// Background service worker entry point
import { generateUUID } from '/src/utils.js';

// Store active tabs that are awaiting authentication
let authTabs = new Set();
// Cache auth tokens
let authTokenCache = new Map();
let offscreenHandle;

// Add debugging with timestamps
const debug = (...args) => {
  const timestamp = new Date().toISOString();
  console.log(`[Copilot Background ${timestamp}]`, ...args);
  console.trace(); // Add stack trace for debugging
};

// Add token refresh mechanism with detailed logging
async function refreshAuthToken() {
  try {
    debug('START: Attempting to refresh auth token');
    const url = 'https://copilot.microsoft.com/api/auth/token';
    debug('Fetching from URL:', url);
    
    const requestId = generateUUID();
    debug('Generated request ID:', requestId);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      credentials: 'include'
    });
    
    debug('Token refresh response status:', response.status);
    debug('Token refresh response headers:', Object.fromEntries(response.headers.entries()));
    
    if (response.ok) {
      const data = await response.json();
      debug('Token refresh response data:', { ...data, accessToken: data.accessToken ? '[REDACTED]' : undefined });
      
      if (data.accessToken) {
        debug('Token refresh successful, caching token');
        authTokenCache.set('copilot', {
          token: data.accessToken,
          timestamp: Date.now()
        });
        return data;
      }
    }
    debug('Token refresh failed with status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      debug('Error response body:', errorText);
    }
    return null;
  } catch (error) {
    debug('Token refresh error:', error);
    debug('Error stack:', error.stack);
    return null;
  }
}

// Clean up function for WebSocket connections
function cleanup() {
  debug('Cleaning up WebSocket connections');
  // Close auth tabs
  authTabs.forEach(tabId => {
    chrome.tabs.remove(tabId).catch(() => {
      // Ignore errors for already closed tabs
    });
  });
  authTabs.clear();
  
  // Clear auth cache
  authTokenCache.clear();
  
  // Close offscreen document
  if (offscreenHandle) {
    closeOffscreenDocument().catch(debug);
  }
}

// Listen for extension unload
chrome.runtime.onSuspend.addListener(cleanup);

// Add connection cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (authTabs.has(tabId)) {
    debug('Auth tab closed:', tabId);
    authTabs.delete(tabId);
  }
});

// Add periodic auth token refresh
setInterval(async () => {
  const cached = authTokenCache.get('copilot');
  if (cached && Date.now() - cached.timestamp > 3000000) { // Refresh after 50 minutes
    debug('Refreshing auth token');
    await refreshAuthToken(cached.token);
  }
}, 300000); // Check every 5 minutes

// Handle Copilot API requests with improved error handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'copilot-auth') {
    const tabId = sender.tab?.id;
    debug('Received auth request from tab:', tabId);
    debug('Full message:', message);
    debug('Sender details:', sender);
    
    // Check cache first
    const cached = authTokenCache.get('copilot');
    if (cached) {
      debug('Found cached token from:', new Date(cached.timestamp).toISOString());
      const age = Date.now() - cached.timestamp;
      debug('Token age (ms):', age);
      
      if (age < 3600000) { // 1 hour
        debug('Using cached token (age < 1h)');
        sendResponse({ success: true, data: { accessToken: cached.token } });
        return true;
      }
      debug('Cached token expired');
    }

    // Check if we already have valid cookies
    chrome.cookies.getAll({ 
      domain: 'copilot.microsoft.com'
    }, async (cookies) => {
      try {
        debug('Found cookies:', cookies.length);
        debug('Cookie details:', cookies.map(c => ({ 
          name: c.name,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : undefined
        })));
        
        const authCookie = cookies.find(c => c.name === '_C_Auth');
        if (authCookie) {
          debug('Found auth cookie, expires:', new Date(authCookie.expirationDate * 1000).toISOString());
          debug('Attempting to get token with cookie');
          const data = await refreshAuthToken();
          if (data) {
            debug('Successfully obtained new token');
            sendResponse({ success: true, data });
            return;
          }
        }

        debug('No valid auth found, initiating login flow');
        authTokenCache.delete('copilot');
        
        // Check if we already have an auth tab open
        const existingTab = Array.from(authTabs).find(async (id) => {
          try {
            const tab = await chrome.tabs.get(id);
            return tab?.url?.includes('copilot.microsoft.com');
          } catch {
            authTabs.delete(id);
            return false;
          }
        });

        if (existingTab) {
          debug('Auth tab already open:', existingTab);
          sendResponse({ success: false, error: 'Authentication in progress' });
          return;
        }

        // Open Copilot in a new tab
        chrome.tabs.create({
          url: 'https://copilot.microsoft.com/chat',
          active: true
        }, (tab) => {
          authTabs.add(tab.id);
          debug('Created new auth tab:', tab.id);
        });

        sendResponse({ success: false, error: 'Authentication required' });
      } catch (error) {
        debug('Authentication error:', error);
        debug('Error stack:', error.stack);
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  if (message.action === 'socket') {
    debug('WebSocket action received:', message);
    handleActionWebsocket(message)
      .then(response => {
        debug('WebSocket action response:', response);
        sendResponse(response);
      })
      .catch(error => {
        debug('WebSocket action error:', error);
        sendResponse({ error: error.toString() });
      });
    return true;
  }

  if (message.action === 'setup-offscreen') {
    debug('Setting up offscreen document');
    setupOffscreenDocument('https://copilot.microsoft.com/favicon.ico?copilot-chat')
      .then(() => sendResponse(true))
      .catch((error) => {
        debug('Offscreen setup error:', error);
        sendResponse(false);
      });
    return true;
  }
});

// Listen for tab updates to detect when auth is complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (authTabs.has(tabId) && changeInfo.status === 'complete') {
    debug('Auth tab updated:', tabId, changeInfo.status);
    if (tab.url?.startsWith('https://copilot.microsoft.com/chat')) {
      // Check if we're authenticated
      chrome.cookies.get({
        url: 'https://copilot.microsoft.com',
        name: '_C_Auth'
      }, async (cookie) => {
        debug('Checking auth cookie:', cookie ? 'found' : 'not found');
        if (cookie) {
          // Try to get an auth token
          const data = await refreshAuthToken();
          if (data) {
            debug('Successfully authenticated and token retrieved');
            // Close the auth tab
            chrome.tabs.remove(tabId);
            authTabs.delete(tabId);
            
            // Notify all tabs that auth is complete
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { 
                  action: 'auth-complete',
                  data: { accessToken: data.accessToken }
                }).catch(() => {
                  // Ignore errors for tabs that don't have listeners
                });
              });
            });
          }
        }
      });
    }
  }
});

async function setupOffscreenDocument(path) {
  // Check if we already have an offscreen document
  if (offscreenHandle) return;

  // Create an offscreen document if one is not already available.
  try {
    offscreenHandle = await chrome.offscreen.createDocument({
      url: path,
      reasons: ['WEBSOCKET'],
      justification: 'Managing WebSocket connections'
    });
    debug('Created offscreen document for WebSocket handling');
  } catch (error) {
    debug('Error creating offscreen document:', error);
    throw error;
  }
}

async function closeOffscreenDocument() {
  if (!offscreenHandle) return;
  await chrome.offscreen.closeDocument();
  offscreenHandle = null;
  debug('Closed offscreen document');
}