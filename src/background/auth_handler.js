// Auth handler for Copilot
import { generateUUID } from '../utils.js';
import { debug } from './init.js';

// Store active tabs that are awaiting authentication
const authTabs = new Set();
// Cache auth tokens
const authTokenCache = new Map();

// Add token refresh mechanism with proper cookie handling
async function refreshAuthToken() {
  try {
    debug('START: Attempting to refresh auth token');
    const requestId = generateUUID();
    
    // First check if we have valid cookies
    const cookies = await chrome.cookies.getAll({ domain: 'copilot.microsoft.com' });
    debug('Current cookies:', cookies.map(c => ({
      name: c.name,
      expiresUTC: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : undefined
    })));

    // Check _C_ETH cookie which must be present
    const ethCookie = cookies.find(c => c.name === '_C_ETH');
    if (!ethCookie) {
      debug('Missing _C_ETH cookie, setting it');
      await chrome.cookies.set({
        url: 'https://copilot.microsoft.com',
        name: '_C_ETH',
        value: '1',
        secure: true,
        httpOnly: true,
        expirationDate: Math.floor(Date.now() / 1000) + 86400
      });
    }

    const response = await fetch('https://copilot.microsoft.com/api/auth/token', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-request-id': requestId,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      credentials: 'include'
    });
    
    debug('Token refresh response status:', response.status);
    const responseHeaders = Object.fromEntries(response.headers.entries());
    debug('Token refresh response headers:', responseHeaders);
    
    // Handle Set-Cookie headers
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    if (setCookieHeaders.length > 0) {
      debug('Processing Set-Cookie headers:', setCookieHeaders);
      for (const cookieStr of setCookieHeaders) {
        // Parse and set cookies that are being set by the server
        const cookieMatch = cookieStr.match(/^([^=]+)=([^;]*)/);
        if (cookieMatch) {
          const [, name, value] = cookieMatch;
          await chrome.cookies.set({
            url: 'https://copilot.microsoft.com',
            name,
            value,
            secure: true,
            httpOnly: true
          });
          debug('Set cookie:', name);
        }
      }
    }
    
    if (response.ok) {
      const data = await response.json();
      debug('Token refresh response:', {
        ...data,
        accessToken: data.accessToken ? '[REDACTED]' : undefined
      });
      
      if (data.accessToken) {
        debug('Token refresh successful, caching token');
        authTokenCache.set('copilot', {
          token: data.accessToken,
          timestamp: Date.now()
        });
        return data;
      }
    }

    // Log failure details
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

// Handle auth requests with cookie management
export async function handleAuth(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  debug('Received auth request from tab:', tabId);
  
  try {
    // Check cache first
    const cached = authTokenCache.get('copilot');
    if (cached) {
      debug('Found cached token from:', new Date(cached.timestamp).toISOString());
      const age = Date.now() - cached.timestamp;
      debug('Token age (ms):', age);
      
      if (age < 3600000) { // 1 hour
        debug('Using cached token (age < 1h)');
        
        // Verify cookies are still valid
        const cookies = await chrome.cookies.getAll({ domain: 'copilot.microsoft.com' });
        const authCookie = cookies.find(c => c.name === '_C_Auth');
        if (authCookie) {
          debug('Auth cookie valid, using cached token');
          sendResponse({ success: true, data: { accessToken: cached.token } });
          return true;
        }
        debug('Auth cookie missing despite cached token');
      } else {
        debug('Cached token expired');
      }
      authTokenCache.delete('copilot');
    }

    // Don't proceed if authentication is already in progress
    const isAuthInProgress = Array.from(authTabs.values()).some(id => {
      try {
        return chrome.tabs.get(id);
      } catch {
        authTabs.delete(id);
        return false;
      }
    });

    if (isAuthInProgress) {
      debug('Authentication already in progress');
      sendResponse({ success: false, error: 'Authentication in progress' });
      return true;
    }

    // Check if we already have valid cookies and can refresh token
    const data = await refreshAuthToken();
    if (data?.accessToken) {
      debug('Successfully obtained new token');
      sendResponse({ success: true, data });
      return true;
    }

    // Need to perform full authentication
    debug('Full authentication needed, opening Copilot');
    const tab = await chrome.tabs.create({
      url: 'https://copilot.microsoft.com/chat',
      active: true
    });
    
    authTabs.add(tab.id);
    debug('Created auth tab:', tab.id);
    sendResponse({ success: false, error: 'Authentication required' });
    return true;
  } catch (error) {
    debug('Auth error:', error);
    debug('Error stack:', error.stack);
    sendResponse({ success: false, error: error.message });
    return true;
  }
}

// Monitor auth tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (authTabs.has(tabId) && changeInfo.status === 'complete') {
    debug('Auth tab updated:', tabId, changeInfo.status);
    if (tab.url?.startsWith('https://copilot.microsoft.com/chat')) {
      (async () => {
        try {
          // Try to get an auth token
          const data = await refreshAuthToken();
          if (data?.accessToken) {
            debug('Successfully authenticated and retrieved token');
            // Close the auth tab
            await chrome.tabs.remove(tabId);
            authTabs.delete(tabId);
            
            // Notify all tabs that auth is complete
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
              try {
                await chrome.tabs.sendMessage(tab.id, { 
                  action: 'auth-complete',
                  data: { accessToken: data.accessToken }
                });
              } catch (e) {
                // Ignore errors for tabs without listeners
              }
            }
          }
        } catch (error) {
          debug('Error during auth completion:', error);
        }
      })();
    }
  }
});

// Clean up auth tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  if (authTabs.has(tabId)) {
    debug('Auth tab closed:', tabId);
    authTabs.delete(tabId);
  }
});

// Export function for background worker
export { refreshAuthToken };