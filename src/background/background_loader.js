import { ExtPay } from '../libs/ExtPay.js';
import './background_extpay.js';
import { generateUUID } from '../utils.js';
import { handleActionWebsocket } from './websocket_utils.js';
import './background.js';

// Store active tabs that are awaiting authentication
let authTabs = new Set();

// Add debugging
const debug = (...args) => console.log('[Copilot Debug]', ...args);

// Handle Copilot API requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'copilot-auth') {
    debug('Attempting Copilot authentication');
    // Check if we already have valid cookies for copilot.microsoft.com
    chrome.cookies.get({
      url: 'https://copilot.microsoft.com',
      name: '_C_Auth'
    }, async (cookie) => {
      try {
        if (cookie) {
          debug('Found existing Copilot cookie:', cookie.value.substring(0, 10) + '...');
          // We have a valid cookie, try to get the access token
          const response = await fetch('https://copilot.microsoft.com/api/auth/token', {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            credentials: 'include'
          });
          
          if (response.ok) {
            const data = await response.json();
            debug('Successfully retrieved access token');
            sendResponse({ success: true, data });
            return;
          }
          debug('Failed to get access token:', response.status);
        }

        debug('No valid cookie found, opening Copilot auth tab');
        // Open Copilot in a new tab to trigger auth
        chrome.tabs.create({
          url: 'https://copilot.microsoft.com/chat',
          active: true
        }, (tab) => {
          authTabs.add(tab.id);
          debug('Created auth tab:', tab.id);
        });

        sendResponse({ success: false, error: 'Authentication required' });
      } catch (error) {
        debug('Authentication error:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }
});

// Listen for tab updates to detect when auth is complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (authTabs.has(tabId) && changeInfo.status === 'complete') {
    debug('Auth tab updated:', tabId, changeInfo.status);
    if (tab.url.startsWith('https://copilot.microsoft.com/chat')) {
      // Check if we're authenticated
      chrome.cookies.get({
        url: 'https://copilot.microsoft.com',
        name: '_C_Auth'
      }, (cookie) => {
        debug('Checking auth cookie:', cookie ? 'found' : 'not found');
        if (cookie) {
          debug('Successfully authenticated, closing auth tab');
          // We're authenticated, close the tab
          chrome.tabs.remove(tabId);
          authTabs.delete(tabId);
          
          // Notify the original tab that auth is complete
          chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, { 
                action: 'auth-complete'
              }).catch(() => {
                // Ignore errors for tabs that don't have listeners
              });
            });
          });
        }
      });
    }
  }
});
