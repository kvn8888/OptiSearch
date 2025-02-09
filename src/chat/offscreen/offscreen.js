// Constants and configuration for script and iframe source
const strings = {
  // List of script paths required by the iframe
  scripts: ["src/background/websocket_utils.js", "src/chat/offscreen/bing_socket.js"],
  // URL for the iframe source; uses Bing's favicon with a custom query parameter.
  iframeSrc: "https://www.bing.com/sa/simg/favicon-trans-bg-blue-mg.ico?bing-chat-gpt-4-in-google",
};

// Object to track the readiness of the socket script in the iframe.
// It uses a setter to trigger a listener when its value changes and provides a promise
// that resolves when the socket script is ready.
const socketScriptReady = {
  _val: false,
  _listener: () => {},
  set val(val) {
    this._val = val;
    // Notify any awaiting functionality that the value has been set.
    this._listener(val);
  },
  get val() {
    return this._val;
  },
  // Promise resolves once the socket script is signaled as ready.
  get promise() {
    return new Promise(resolve => this._listener = resolve);
  }
};

// Initiates the iframe setup by converting script paths to their full URLs.
setupIframe(strings.scripts.map((src) => chrome.runtime.getURL(src)));

// ...
// setupIframe function: Creates an iframe, sets up message listeners, and handles communication.
function setupIframe(scripts) {
  // Create the iframe element using the provided source URL.
  const iframe = createIframe(strings.iframeSrc);

  // Global event listener for messages from the iframe.
  window.addEventListener('message', ({data}) => {
    // Use a switch-case to handle different message types.
    switch (data) {
      // When the iframe indicates its scripts are ready, inject the required scripts.
      case 'iframe-script-ready':
        injectScriptToIframe(iframe, scripts);
        break;
      // When the socket script inside the iframe is ready, update the readiness flag.
      case 'socket-script-ready':
        socketScriptReady.val = true;
        break;
    }
  });

  // Listen for messages from the Chrome extension.
  chrome.runtime.onMessage.addListener(onReceiveMessageFromExtension);
}

// ...
// createIframe function: Dynamically creates an iframe element with a given source URL.
function createIframe(src) {
  const iframe = document.createElement('iframe');
  // Set iframe's source.
  iframe.src = src;
  // Append iframe to the document to render it.
  document.firstElementChild.appendChild(iframe);
  return iframe;
}

// ...
// injectScriptToIframe function: Sends instructions to the iframe to load specified scripts.
function injectScriptToIframe(iframe, scripts) {
  const iframeWindow = iframe.contentWindow;
  // Post a message to the iframe containing the script URLs.
  iframeWindow.postMessage({ scripts }, "*");
}

// ...
// onReceiveMessageFromExtension function: Handles messages sent from the Chrome extension.
function onReceiveMessageFromExtension(message, _, sendResponse) {
  // Ignore messages not intended for the offscreen context.
  if (message.target !== 'offscreen') return;
  switch (message.action) {
    // For 'url' action, respond with the current window location URL.
    case 'url':
      sendResponse(window.location.href);
      break;
    // For other actions, forward the message to the iframe and return its response.
    default:
      sendMessageToIframe(message).then(sendResponse);
      break;
  }
  return true; // Indicate asynchronous response.
}

// ...
// sendMessageToIframe function: Forwards a message to the iframe and awaits a reply.
// It waits for the socket script to be ready before sending the message.
async function sendMessageToIframe(message) {
  const iframe = document.querySelector('iframe');
  if (!iframe) {
    throw 'No iframe'; // Error if iframe is not found.
  }

  // Wait for the socket script to signal readiness.
  if (!socketScriptReady.val) {
    await socketScriptReady.promise;
  }

  // Generate a unique message ID for response matching.
  const messageId = Math.random().toString(36).substring(7);
  return new Promise(resolve => {
    // Listener for the response message containing the unique messageId.
    const messageHandler = (event) => {
      if (event.data && event.data.messageId === messageId) {
        resolve(event.data.message);
        // Remove this event listener after receiving the expected message.
        window.removeEventListener('message', messageHandler);
      }
    };

    // Wait for messages from the window.
    window.addEventListener('message', messageHandler);
    // Post the message to the iframe with the unique ID.
    iframe.contentWindow.postMessage({ message, messageId }, '*');
  });
}
