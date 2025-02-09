// Cleanup utilities for background worker
import { handleActionWebsocket } from './websocket_utils.js';

let cleanupInProgress = false;

async function cleanup() {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  console.log('[Copilot Background] Starting cleanup');
  
  try {
    // Close offscreen document if it exists
    if (chrome.offscreen) {
      await chrome.offscreen.closeDocument();
    }

    // Clear all auth states
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'cleanup' });
      } catch (e) {
        // Tab might not have our content script
      }
    }

  } catch (error) {
    console.error('[Copilot Background] Cleanup error:', error);
  } finally {
    cleanupInProgress = false;
  }
}

// Listen for extension unload
chrome.runtime.onSuspend.addListener(cleanup);

export { cleanup };