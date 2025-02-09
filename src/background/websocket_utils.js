// WebSocket utilities module
const websockets = [];
const debug = (...args) => console.log('[Copilot WebSocket]', ...args);

// Rate limiting and request tracking
const rateLimits = {
  requests: new Map(), // Track request counts
  windowMs: 60000, // 1 minute window
  maxRequests: 25, // Maximum requests per window
};

function checkRateLimit() {
  const now = Date.now();
  // Clean up old entries
  for (const [timestamp] of rateLimits.requests) {
    if (now - timestamp > rateLimits.windowMs) {
      rateLimits.requests.delete(timestamp);
    }
  }
  
  // Check if we're over the limit
  if (rateLimits.requests.size >= rateLimits.maxRequests) {
    return false;
  }
  
  // Add new request
  rateLimits.requests.set(now, true);
  return true;
}

class Stream {
  constructor() {
    this.buffer = [];
    this.readPromise = null;
  }

  async read() {
    if (this.buffer.length > 0)
      return this.buffer.shift();

    if (this.readPromise === null) {
      this.readPromise = new Promise(resolve => this.resolveReadPromise = resolve);
    }
    return this.readPromise;
  }

  write(data) {
    debug('Received:', data);
    this.buffer.push(data);
    if (this.readPromise !== null) {
      this.resolveReadPromise(this.buffer.shift());
      this.readPromise = null;
    }
  }
}

export async function handleActionWebsocket(action, tryTimes = 3) {
  // Check rate limit before proceeding
  if (!checkRateLimit()) {
    debug('Rate limit exceeded, waiting...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    return handleActionWebsocket(action, tryTimes);
  }

  const { socketID, url, toSend, headers = {} } = action;
  
  if (socketID == null) {
    debug('Creating new WebSocket connection:', url);
    let ws = null;
    try {
      // Setup WebSocket with required headers
      const wsUrl = new URL(url);
      ws = new WebSocket(wsUrl.toString(), 'chat');

      // Add required headers from Copilot protocol
      Object.assign(ws, {
        webSocketHeaders: {
          'Upgrade': 'websocket',
          'Origin': 'https://copilot.microsoft.com',
          'Sec-WebSocket-Protocol': 'chat',
          'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...headers
        }
      });

      // Add keepalive ping with proper timing from logs
      let pingInterval;
      let lastResponseTime = Date.now();
      
      const startKeepalive = () => {
        debug('Starting keepalive');
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            // Check if we've received any response in last 30 seconds
            if (Date.now() - lastResponseTime > 30000) {
              debug('No response received for 30s, closing connection');
              ws.close();
              return;
            }
            ws.send(JSON.stringify({ event: "ping" }) + '\x1e');
          }
        }, 15000); // Send ping every 15 seconds as seen in logs
      };

      const stopKeepalive = () => {
        if (pingInterval) {
          debug('Stopping keepalive');
          clearInterval(pingInterval);
          pingInterval = null;
        }
      };

      // Add connection timeout matching Copilot behavior
      let connectionTimeout = setTimeout(() => {
        debug('Connection timeout - closing socket');
        ws.close();
      }, 10000);

      ws.addEventListener('open', () => {
        debug('WebSocket opened successfully');
        clearTimeout(connectionTimeout);
        if (toSend) {
          debug('Sending initial message:', toSend);
          ws.send(toSend);
        }
        startKeepalive();
      });

      // Add proper message handling from logs
      ws.addEventListener('message', ({ data }) => {
        lastResponseTime = Date.now();
        
        // Split on record separator as seen in logs
        const messages = data.split('\x1e').filter(Boolean);
        
        for (const message of messages) {
          try {
            const parsed = JSON.parse(message);
            
            // Handle Copilot protocol events
            switch (parsed.event) {
              case 'pong':
                debug('Received pong');
                return;
                
              case 'error':
                debug('Received error event:', parsed);
                if (parsed.error?.includes('token')) {
                  ws.dispatchEvent(new ErrorEvent('error', { 
                    error: new Error('Token expired'),
                    message: parsed.error 
                  }));
                  return;
                }
                break;
              
              case 'disconnect':
                debug('Received disconnect event');
                ws.close(1000, 'Server requested disconnect');
                return;
            }
          } catch (e) {
            // Not JSON or other parsing error, treat as regular message
          }
          
          ws.stream.write(data);
        }
      });

      ws.addEventListener('error', (error) => {
        debug('WebSocket error:', error);
        clearTimeout(connectionTimeout);
        stopKeepalive();
      });

      ws.addEventListener('close', (event) => {
        debug('WebSocket closed:', event.code, event.reason);
        clearTimeout(connectionTimeout);
        stopKeepalive();
        // Remove the socket from our array if it's closed
        const index = websockets.indexOf(ws);
        if (index > -1) {
          websockets.splice(index, 1);
        }
      });

    } catch (error) {
      debug('WebSocket creation failed:', error);
      if (tryTimes <= 0) {
        return { error: error.toString() };
      }
      const delay = Math.min(1000 * Math.pow(2, 3 - tryTimes), 5000); // Exponential backoff
      debug(`Retrying in ${delay}ms (${tryTimes} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return handleActionWebsocket(action, tryTimes - 1);
    }

    ws.stream = new Stream();
    websockets.push(ws);

    const socketID = websockets.length - 1;
    debug('WebSocket created with ID:', socketID);
    return { socketID };
  }

  const ws = websockets[socketID];
  if (!ws) {
    debug('WebSocket not found:', socketID);
    return { error: `Error: websocket ${socketID} not available` };
  }

  if (toSend) {
    if (toSend.includes('"event":"close"')) {
      debug('Closing WebSocket', socketID);
      try {
        ws.close(1000, 'Intentional close');
        // Remove from our tracking array
        websockets[socketID] = null;
        // Wait for close to complete
        await new Promise((resolve) => {
          const checkClosed = () => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
            } else {
              setTimeout(checkClosed, 50);
            }
          };
          checkClosed();
        });
        return { status: 'Closed' };
      } catch (error) {
        debug('Error closing socket:', error);
        return { error: error.toString() };
      }
    }

    if (ws.readyState !== WebSocket.OPEN) {
      debug('WebSocket not open, state:', ws.readyState);
      return { error: 'WebSocket not in OPEN state' };
    }
    debug('Sending message on socket', socketID, ':', toSend);
    ws.send(toSend);
    return { status: 'Success' };
  }

  debug('Reading from socket', socketID, 'state:', ws.readyState);
  const packet = await ws.stream.read();
  return { 
    readyState: ws.readyState, 
    packet 
  };
}
