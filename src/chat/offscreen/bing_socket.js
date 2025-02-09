/**
 * Overview:
 * This script handles incoming messages from the parent window to perform network requests
 * to Bing endpoints (e.g., creating or deleting a conversation session) or forward actions to a WebSocket handler.
 */

// Signal to the parent window that the socket script has been loaded and is ready.
window.parent.postMessage('socket-script-ready', '*');

// Listen for messages from the parent window.
window.addEventListener('message', async (event) => {
  // When a message arrives, process the 'message' property with handleMessage
  // and send back the result along with the original messageId for matching.
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
      // Create a new conversation session by requesting Bing's conversation creation endpoint.
      const response = await fetch(`https://www.bing.com/turing/conversation/create`, {
        credentials: "include",
      });
      const ret = await response.json();
      // Retrieve and attach custom conversation signature headers if available.
      if (response.headers.has('X-Sydney-Conversationsignature')) {
        ret['conversationSignature'] = response.headers.get('X-Sydney-Conversationsignature');
      }
      if (response.headers.has('X-Sydney-Encryptedconversationsignature')) {
        ret['sec_access_token'] = response.headers.get('X-Sydney-Encryptedconversationsignature');
      }
      return ret;
    case 'delete':
      // Delete a conversation by sending a POST request with necessary authentication and conversation details.
      return (await fetch('https://sydney.bing.com/sydney/DeleteSingleConversation', {
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${message.conversationSignature}`,
        },
        body: JSON.stringify({
          "conversationId": message.conversationId,
          "participant": {
            "id": message.clientId
          },
          "source": "cib",
          "optionsSets": [
            "autosave"
          ]
        }),
        method: "POST",
        mode: "cors",
      })).json();
    default:
      // For all other actions, delegate to the existing WebSocket handler.
      return handleActionWebsocket(message);
  }
}
