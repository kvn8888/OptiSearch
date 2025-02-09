class BingChatSession extends ChatSession {
  static debug = (...args) => console.log('[Copilot Session]', ...args);

  properties = {
    name: "Copilot",
    link: "https://copilot.microsoft.com/",
    icon: "src/images/copilot.png",
    local_icon: "copilot.png",
    href: "https://copilot.microsoft.com/chat",
  }
  static errors = {
    session: {
      code: 'COPILOT_SESSION',
      url: 'https://copilot.microsoft.com/chat',
      text: _t("Please wait while we open Microsoft Copilot for authentication..."),
      button: _t("Open Copilot"),
    },
    auth: {
      code: 'COPILOT_AUTH',
      text: _t("Authentication in progress. Please complete the login in the opened tab."),
    }
  }
  static get storageKey() {
    return "SAVE_BINGCHAT";
  }

  async internalSearchActivated() {
    if (Context.get('bingInternalSearch')) return true;
    const notPremium = await Context.checkIfUserStillNotPremium();
    if (notPremium) {
      Context.set('bingInternalSearch', true);
      return true;
    }
    return false;
  }

  /** @type {HTMLImageElement | null} */
  bingIconElement = null;

  constructor() {
    super('bingchat');
    this.socketID = null;
    this.uuid = generateUUID(); // for conversation continuation
    this.retryCount = 0;
    this.maxRetries = 3;
    this.reconnectDelay = 1000; // Start with 1 second delay
    
    // Attempt to restore session on startup
    this.restoreSession();
    
    // Listen for auth completion with token
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'auth-complete' && message.data?.accessToken) {
        BingChatSession.debug('Auth completed with token, updating session');
        this.session = {
          accessToken: message.data.accessToken,
          conversationId: generateUUID(),
          isStartOfSession: true
        };
        // Save the new session
        this.saveSession();
        // Retry the conversation
        this.setupAndSend();
      }
    });

    // Handle visibility changes
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          BingChatSession.debug('Tab became visible, checking session');
          this.restoreSession();
        }
      });
    }
  }

  async init() {
    BingChatSession.debug('Initializing session');
    if (ChatSession.debug) return;
    try {
      await this.fetchSession();
      BingChatSession.debug('Session initialized successfully');
    } catch (error) {
      BingChatSession.debug('Session initialization failed:', error);
      throw error;
    }
  }

  async fetchSession() {
    BingChatSession.debug('Fetching session');
    const sessionURL = await this.parseSessionFromURL();
    if (sessionURL) {
      BingChatSession.debug('Found session from URL');
      this.isContinueSession = true;
      this.session = sessionURL;
      return this.session;
    }

    try {
      BingChatSession.debug('Requesting authentication');
      const response = await chrome.runtime.sendMessage({ action: 'copilot-auth' });
      BingChatSession.debug('Auth response:', response?.success);

      if (!response.success) {
        if (response.error === 'Authentication required') {
          BingChatSession.debug('Authentication required, waiting for login');
          throw { ...BingChatSession.errors.auth, message: response.error };
        }
        throw BingChatSession.errors.session;
      }

      if (!response.data?.accessToken) {
        BingChatSession.debug('No access token in response');
        throw BingChatSession.errors.session;
      }

      this.session = {
        accessToken: response.data.accessToken,
        conversationId: this.uuid,
        isStartOfSession: true
      };
      
      // Save the new session
      await this.saveSession();
      
      BingChatSession.debug('Session created successfully');
      return this.session;
    } catch (error) {
      BingChatSession.debug('Session fetch error:', error);
      throw error;
    }
  }

  async parseSessionFromURL() {
    if (!window.location.hostname.endsWith('.microsoft.com'))
      return;
    
    const params = new URLSearchParams(window.location.search);
    const continueSession = params.get('continuesession');
    if (!continueSession)
      return;

    const session = await bgWorker({ action: 'session-storage', type: 'get', key: continueSession });
    if (!session || session.inputText !== parseSearchParam())
      return;
    
    return session;
  }

  async send(prompt) {
    super.send(prompt);
    if (ChatSession.debug) return;

    try {
      this.bingIconElement?.classList.add('disabled');
      this.socketID = await this.createSocket();
      
      await this.socketSend({
        event: "send",
        conversationId: this.session.conversationId,
        content: [{ type: "text", text: prompt }],
        mode: "chat"
      });

      return this.next();
    } catch (error) {
      BingChatSession.debug('Send error:', error);
      // Clear the socket ID so we create a new one on retry
      this.socketID = null;
      await this.handleActionError(error);
      
      // Only retry if it's an authentication error
      if (error?.message === 'Authentication required') {
        BingChatSession.debug('Waiting for authentication to complete...');
        // The auth handler will trigger a retry
        return;
      }
    }
  }

  createPanel(directchat = true) {
    super.createPanel(directchat);

    const buildInternalSearchButton = () => {
      const glass = el('div', {
        className: 'bing-search-button',
      });
      const updateInternalSearchButton = async () => {
        const activated = await this.internalSearchActivated();
        glass.textContent = '';
        setSvg(glass, SVG[activated ? 'magnifyingGlass' : 'emptySet'])
        glass.title = activated ? _t("Internal search enabled") : _t("Internal search disabled");
      };
      updateInternalSearchButton();
      glass.addEventListener('click', async () => {
        if (await Context.handleNotPremium()) return;
        Context.set('bingInternalSearch', !Context.get('bingInternalSearch'));
      });
      Context.addSettingListener('bingInternalSearch', updateInternalSearchButton);
      Context.addSettingListener('premium', updateInternalSearchButton);
      return glass;
    };
    const leftButtonsContainer = $('.left-buttons-container', this.panel);
    leftButtonsContainer.append(buildInternalSearchButton());    

    this.bingIconElement = $('img', $('.ai-name', this.panel));
    const updateIconButton = (mode = 'balanced') => {
      const displayName = Settings['AI Assitant']['bingConvStyle'].options[mode].name;
      this.bingIconElement.title = displayName;
      $('.optiheader', this.panel).dataset['bingConvStyle'] = mode;
    }
    this.bingIconElement.addEventListener('click', async () => {
      if (this.bingIconElement.classList.contains('disabled')) {
        return;
      }

      const modes = ['balanced', 'precise', 'creative'];
      const current = Context.get('bingConvStyle') || modes[0];
      Context.set('bingConvStyle', modes.at((modes.indexOf(current) + 1) % modes.length));
    });
    updateIconButton(Context.get('bingConvStyle'));
    Context.addSettingListener('bingConvStyle', updateIconButton);

    return this.panel;
  }

  async next() {
    try {
      const res = await this.socketReceive();
      if (!res) return;

      const { packet, readyState } = res;
      BingChatSession.debug('Socket state:', readyState, 'Received:', packet?.substring(0, 100));
      
      if (readyState !== WebSocket.OPEN) {
        BingChatSession.debug('Socket not open, attempting reconnect');
        if (this.retryCount < this.maxRetries) {
          this.socketID = null; // Force new socket creation
          this.socketID = await this.createSocket();
          return this.next();
        }
        throw new Error("WebSocket connection lost");
      }

      const messages = packet.split('\x1e')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            BingChatSession.debug('Message parse error:', e, line);
            return null;
          }
        })
        .filter(msg => msg);

      for (const msg of messages) {
        BingChatSession.debug('Processing message:', msg.event);
        switch (msg.event) {
          case 'appendText':
            this.onMessage(msg.text);
            break;
          case 'error':
            if (msg.error?.includes('token')) {
              BingChatSession.debug('Token error, refreshing session');
              this.session = null;
              await this.init();
              this.socketID = await this.createSocket();
              return this.next();
            }
            throw msg;
          case 'disconnect':
            if (this.retryCount < this.maxRetries) {
              BingChatSession.debug('Received disconnect, attempting reconnect');
              this.socketID = null;
              this.socketID = await this.createSocket();
              return this.next();
            }
            throw new Error("Connection terminated by server");
          case 'suggestedFollowups':
            this.suggestions = msg.suggestions;
            break;
          case 'done':
            BingChatSession.debug('Conversation complete');
            this.allowSend();
            return;
        }
      }
      
      return this.next();
    } catch (error) {
      BingChatSession.debug('Next error:', error);
      await this.handleActionError(error);
    }
  }

  async saveSession() {
    if (!this.session) return;
    
    try {
      await chrome.storage.local.set({
        'copilot_session': {
          accessToken: this.session.accessToken,
          timestamp: Date.now()
        }
      });
      BingChatSession.debug('Session saved');
    } catch (error) {
      BingChatSession.debug('Failed to save session:', error);
    }
  }

  async restoreSession() {
    try {
      const data = await chrome.storage.local.get('copilot_session');
      const saved = data.copilot_session;
      
      if (saved && Date.now() - saved.timestamp < 3600000) { // 1 hour
        BingChatSession.debug('Restoring saved session');
        this.session = {
          accessToken: saved.accessToken,
          conversationId: generateUUID(),
          isStartOfSession: true
        };
      } else if (saved) {
        // Clear expired session
        await chrome.storage.local.remove('copilot_session');
      }
    } catch (error) {
      BingChatSession.debug('Failed to restore session:', error);
    }
  }

  async removeConversation() {
    if (ChatSession.debug || !this.session)
      return Promise.resolve();
      
    // Clean up WebSocket connection with retry
    if (this.socketID != null) {
      try {
        const result = await BingChatSession.offscreenAction({
          action: "socket",
          socketID: this.socketID,
          toSend: JSON.stringify({ event: "close" }) + '\x1e'
        });

        if (result.error) {
          BingChatSession.debug('Error closing WebSocket:', result.error);
          // Socket might already be closed, continue with cleanup
        }

        // Wait a bit to ensure the socket is fully closed
        await new Promise(resolve => setTimeout(resolve, 100));
        this.socketID = null;
      } catch (error) {
        BingChatSession.debug('Failed to close WebSocket:', error);
      }
    }

    // Clear stored session on explicit removal
    try {
      await chrome.storage.local.remove('copilot_session');
      BingChatSession.debug('Session removed');
    } catch (error) {
      BingChatSession.debug('Failed to remove session:', error);
    } finally {
      // Clear in-memory session state
      this.session = null;
      this.retryCount = 0;
      this.reconnectDelay = 1000;
    }
    
    return Promise.resolve();
  }

  async createSocket() {
    if (!this.session?.accessToken) {
      BingChatSession.debug('No access token available');
      throw BingChatSession.errors.session;
    }

    try {
      const url = `wss://copilot.microsoft.com/c/api/chat?api-version=2&accessToken=${encodeURIComponent(this.session.accessToken)}`;
      BingChatSession.debug('Creating WebSocket:', url);
      
      const res = await BingChatSession.offscreenAction({
        action: "socket",
        url,
        headers: {
          'Origin': 'https://copilot.microsoft.com',
          'Sec-WebSocket-Protocol': 'chat'
        },
        toSend: JSON.stringify({
          event: "setOptions",
          supportedCards: ["image"],
          ads: { supportedTypes: ["multimedia", "product", "tourActivity", "propertyPromotion", "text"] }
        }) + '\x1e'
      });

      if (!('socketID' in res)) {
        BingChatSession.debug('Failed to get socket ID:', res);
        if (res.error?.includes('not in OPEN state')) {
          // Connection failed to establish, retry auth
          this.session = null;
          throw BingChatSession.errors.session;
        }
        throw new Error("Failed to create WebSocket connection");
      }

      BingChatSession.debug('Socket created successfully:', res.socketID);
      this.retryCount = 0;
      return res.socketID;
    } catch (error) {
      this.retryCount++;
      BingChatSession.debug(`Socket creation failed (attempt ${this.retryCount}):`, error);
      if (this.retryCount < this.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, this.retryCount), 5000);
        BingChatSession.debug(`Retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.createSocket();
      }
      throw error;
    }
  }

  socketSend(body) {
    if (this.socketID == null) {
      throw "Need socket ID to send";
    }
    // Add record separator for message framing
    return BingChatSession.offscreenAction({
      action: "socket",
      socketID: this.socketID,
      toSend: JSON.stringify(body) + '\x1e',
    });
  }

  async socketReceive() {
    if (this.socketID == null) {
      BingChatSession.debug('No socket ID available, creating new socket');
      this.socketID = await this.createSocket();
    }
    return BingChatSession.offscreenAction({
      action: "socket",
      socketID: this.socketID,
    });
  }

  static async offscreenAction(params) {
    if (onChrome()) {
      await bgWorker({ action: "setup-bing-offscreen" });
    }
    return await bgWorker({
      ...params,
      target: 'offscreen',
    });
  }

  async config(prompt) {
    if (!this.session)
      throw "Session has to be fetched first";
    
    return {
      event: "send",
      conversationId: this.session.conversationId || this.uuid,
      content: [{ type: "text", text: prompt }],
      mode: "chat"
    };
  }

  async handleActionError(error) {
    this.lastError = error;
    
    if (error?.message === 'Authentication required') {
      BingChatSession.debug('Handling auth error, showing message');
      this.onErrorMessage(BingChatSession.errors.auth);
      // Don't clear session here as we might get a token in auth-complete
      return;
    }

    if (error?.message?.includes('WebSocket not in OPEN state') || 
        error?.message?.includes('WebSocket connection lost')) {
      BingChatSession.debug('Connection lost, will retry with new session');
      this.session = null;
      this.socketID = null;
    }
    
    if (error && error.code && error.text) {
      this.setCurrentAction(error.action ?? 'window');
    }
    this.onErrorMessage(error);
  }

  async setupAndSend(prompt) {
    if (!this.sendingAllowed) return;
    
    prompt = prompt ?? parseSearchParam();
    BingChatSession.debug('Setting up conversation with prompt:', prompt);

    this.setCurrentAction(null);
    this.disableSend();
    this.discussion.appendMessage(new MessageContainer(Author.User, escapeHtml(prompt)));
    this.discussion.appendMessage(new MessageContainer(Author.Bot, ''));
    this.onMessage(ChatSession.infoHTML(_t("Waiting for <strong>$AI$</strong>...", this.properties.name)));
    
    try {
      if (!this.canSend()) {
        BingChatSession.debug('No session available, initializing...');
        await this.init();
      }
      if (this.canSend()) {
        BingChatSession.debug('Session ready, sending message');
        await this.send(prompt);
      }
    } catch (error) {
      BingChatSession.debug('Setup error:', error);
      await this.handleActionError(error);
    }
  }
}
