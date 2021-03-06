/*
 * This adapter function connects Inbenta's chatbot solution with InContact
 * InContact documentation: https://developer.niceincontact.com/API/PatronAPI
 *
 * @param {Object} incontactConf [InContact APP configuration]
 *
 */
var inbentaIncontactAdapter = function (incontactConf) {
  // Return an empty function adapter if inContact is disabled (Inbenta's Hyperchat will be used on escalation instead)
  if (!incontactConf.enabled) {
    return function () {};
  } else if (!incontactConf.applicationName || !incontactConf.applicationSecret || !incontactConf.vendorName || !incontactConf.payload.pointOfContact) {
    console.warn('InContact adapter is misconfigured, therefore it has been disabled.');
    console.warn('Make sure applicationName, applicationSecret, pointOfContact and  vendorName are congifured.');
  }

  // Initialize inContact session on/off variable
  var incontactSessionOn;

  // Construct auth code from conf parameters
  incontactConf.authCode = window.btoa(incontactConf.applicationName + '@' + incontactConf.vendorName + ':' + incontactConf.applicationSecret);

  /*
   * InContact session cookies management function
   */
  var IncontactSession = {
    get: function (key) {
      var cookieObj = {};
      document.cookie.split(';').forEach(function (cookiePair) {
        let index = cookiePair.indexOf('=');
        cookieObj[cookiePair.slice(0, index).trim()] = cookiePair.slice(index + 1, cookiePair.length).trim();
      });
      return cookieObj[key];
    },
    set: function (key, value) {
      const currentTime = new Date().getTime();

      const expires = new Date(currentTime + incontactConf.incontactSessionLifetime * 60000);
      document.cookie = key + '=' + value + '; expires=' + expires + '; path=/';
    },
    delete: function (key) {
      var expired = new Date().getTime() - 3600; // Set it to 1h before to auto-expire it
      document.cookie = key + '=; expires=' + expired + '; path=/';
    }
  };

  // Bulk remove InContact session cookies
  function removeIncontactCookies (cookies) {
    if (typeof cookies === 'string') {
      IncontactSession.delete(cookies);
    } else if (Array.isArray(cookies)) {
      cookies.forEach(function (cookie) {
        IncontactSession.delete(cookie);
      });
    }
  }

  return function (chatbot) {
    window.chatbotHelper = chatbot;
    // Initialize inContact auth object
    var auth = {
      tokenUrl: 'https://api.incontact.com/InContactAuthorizationServer/Token',
      accessToken: '',
      resourceBaseUrl: '',
      chatSessionId: '',
      isManagerConnected: false,
      closedOnTimeout: true,
      noResults: 1,
      firstQuestion: '',
      timers: {
        getChatText: 0
      }
    };

    /*
     * Conect to InContact function (triggered onEscalateToAgent)
     */
    var connectToIncontact = function () {
      incontactSessionOn = true;
      // Initiate inContact auth
      updateToken(
        function (resp) {
          auth.accessToken = resp.access_token;
          auth.resourceBaseUrl = resp.resource_server_base_uri;
          IncontactSession.set('incontactAccessToken', auth.accessToken);
          IncontactSession.set('incontactResourceBaseUrl', auth.resourceBaseUrl);
          // Get inContact chat profile info
          getChatProfile();
          // Create inContact chat room
          makeChat(function (resp) {
            auth.chatSessionId = resp.chatSessionId;
            IncontactSession.set('incontactChatSessionId', auth.chatSessionId);
            // Send chatbot conversation to agent
            retrieveLastMessages();
          });
        }
      );
      auth.closedOnTimeout = false;
      // Start "no agents" timeout
      auth.timers.noAgents = setTimeout(function () {
        if (!auth.isManagerConnected) {
          incontactSessionOn = false;
          auth.closedOnTimeout = true;
          clearTimeout(auth.timers.getChatText);
          endChatSession();
          chatbot.actions.displaySystemMessage({
            message: 'no-agents', // Message can be customized in SDKconf -> labels
            translate: true
          });
          enterQuestion();
          chatbot.actions.hideChatbotActivity();
          chatbot.actions.enableInput();
        }
      }, incontactConf.agentWaitTimeout * 1000);
    };

    /*
     * Update (or create) inContact token [request]
     */
    var updateToken = function (callback) {
      var options = {
        type: 'POST',
        url: auth.tokenUrl,
        async: true,
        headers: { 'Authorization': 'basic ' + incontactConf.authCode },
        data: JSON.stringify({
          'grant_type': 'client_credentials',
          'scope': 'PatronApi'
        })
      };

      requestCall(options, callback);
    };

    /*
     * Get inContact chat profile info [request]
     */
    var getChatProfile = function () {
      var options = {
        type: 'GET',
        url: auth.resourceBaseUrl + 'services/' + incontactConf.version + '/points-of-contact/' + incontactConf.payload.pointOfContact + '/chat-profile',
        async: true
      };

      var request = requestCall(options);
      request.onload = request.onerror = function () {
        if (!this.response) {
          return;
        }
        var resp = JSON.parse(this.response);
        if (!resp.chatProfile) {
          return;
        }
        if (incontactConf.agent.avatarImage === '') {
          for (var chatId in resp.chatProfile) {
            if (resp.chatProfile.hasOwnProperty(chatId) && resp.chatProfile[chatId].heroImage) {
              incontactConf.agent.avatarImage = resp.chatProfile[chatId].heroImage;
              break;
            }
          }
        }
      };
    };

    /*
     * Create inContact chat room [request]
     */
    var makeChat = function (callback) {
      var options = {
        type: 'POST',
        url: auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats',
        async: true,
        data: JSON.stringify(incontactConf.payload)
      };
      requestCall(options, callback);
    };

    /*
     * Get inContact agent responses [request]
     */
    var getChatText = function () {
      clearTimeout(auth.timers.getChatText);
      var options = {
        type: 'GET',
        url: auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats/' + auth.chatSessionId + '?timeout=' + incontactConf.getMessageTimeout,
        async: true
      };

      var request = requestCall(options);
      request.onload = request.onerror = function () {
        if (!this.response) {
          return;
        }
        var resp = JSON.parse(this.response);
        if (resp.chatSession) auth.chatSessionId = resp.chatSession;
        IncontactSession.set('incontactChatSessionId', auth.chatSessionId);
        resp.messages.forEach(function (message) {
          if (typeof message.Type !== 'undefined' && typeof message.Status !== 'undefined' && message.Status === 'Active') {
            auth.isManagerConnected = true;
            chatbot.actions.displaySystemMessage({
              message: 'agent-joined', // Message can be customized in SDKconf -> labels
              replacements: { agentName: incontactConf.agent.name },
              translate: true
            });
            chatbot.actions.hideChatbotActivity();
            chatbot.actions.enableInput();
            if (auth.firstQuestion) {
              chatbot.actions.displayChatbotMessage({ type: 'answer', message: auth.firstQuestion });
              auth.firstQuestion = '';
            }
          }

          if (typeof message.Text !== 'undefined' && typeof message.PartyTypeValue !== 'undefined') {
            switch (message.PartyTypeValue) {
              case '1':
              case 'Agent':
                chatbot.actions.displayChatbotMessage({ type: 'answer', message: message.Text });
                break;
              case 'System':
                if (message.Type === 'Ask') {
                  auth.firstQuestion = message.Text;
                }
            }
          }
        });
      };
    };

    /*
     * Send a single message to Incontact [request]
     */
    var sendMessageToIncontact = function (message, author, async, callback, callbackData) {
      if (auth.chatSessionId === '') return;

      async = typeof async === 'boolean' ? async : false;

      var options = {
        type: 'POST',
        url: auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats/' + auth.chatSessionId + '/send-text',
        async: async,
        data: JSON.stringify({
          'label': (author === 'undefined') ? 'User' : author,
          'message': message
        })
      };

      requestCall(options, callback, callbackData);
    };

    /*
     * Send multiple message to Incontact [request] (recursive, ordered)
     */
    var sendMultipleMessagesToIncontact = function (messageArray) {
      if (messageArray.length > 0) {
        var messageObj = messageArray[0];
        var author = '';
        switch (messageObj.user) {
          case 'guest':
            author = 'Client';
            break;
          case 'system':
            author = 'System';
            break;
          default:
            author = 'ChatBot';
        }
        messageArray.shift();
        sendMessageToIncontact(messageObj.message, 'History: ' + author, false, sendMultipleMessagesToIncontact, messageArray);
      }
    };

    /*
     * Close InContact chat session [request]
     */
    var endChatSession = function () {
      if (auth.chatSessionId === '') return;

      var options = {
        type: 'DELETE',
        url: auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats/' + auth.chatSessionId,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      };

      requestCall(options, function () {
        auth.chatSessionId = '';
        auth.isManagerConnected = false;
      });
    };

    /*
     * InContact http [request] template
     */
    var requestCall = function (requestOptions, callback, callbackData) {
      var xmlhttp = new XMLHttpRequest();
      requestOptions.async = true;
      if (!requestOptions.headers) requestOptions.headers = {};
      if (!requestOptions.headers['Authorization']) {
        requestOptions.headers['Authorization'] = 'bearer ' + auth.accessToken;
      }
      requestOptions.headers['Content-Type'] = 'application/json; charset=utf-8';

      xmlhttp.onreadystatechange = function () {
        if (xmlhttp.readyState === XMLHttpRequest.DONE) {
          IncontactSession.set('inbentaIncontactActive', 'active');
          var handle = httpResponseHandler(requestOptions.url);
          if (typeof handle[xmlhttp.status] === 'function') {
            handle[xmlhttp.status]();
          }

          if (callback) {
            if (callbackData) {
              callback(callbackData);
            } else {
              callback(xmlhttp.response ? JSON.parse(xmlhttp.response) : {});
            }
          }
        }
      };

      xmlhttp.open(requestOptions.type, requestOptions.url, requestOptions.async);

      for (var key in requestOptions.headers) {
        if (requestOptions.headers.hasOwnProperty(key)) {
          xmlhttp.setRequestHeader(key, requestOptions.headers[key]);
        }
      }
      xmlhttp.send(requestOptions.data);

      return xmlhttp;
    };

    /*
     * InContact http response handler
     */
    var httpResponseHandler = function (url) {
      var httpCodeErrors = {
        200: function () {
          if (!auth.closedOnTimeout) auth.timers.getChatText = setTimeout(getChatText, incontactConf.getMessageTimeout);
        },
        202: {},
        304: function () {
          if (!auth.closedOnTimeout) auth.timers.getChatText = setTimeout(getChatText, incontactConf.getMessageTimeout);
        },
        400: genericError,
        401: genericError,
        404: agentLeft
      };
      switch (url) {
        case auth.tokenUrl:
          return {};
        case auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats': // post-/contacts/chats
        case auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats/' + auth.chatSessionId + '?timeout=' + incontactConf.getMessageTimeout: // get-/contacts/chats/{chatSession}
        case auth.resourceBaseUrl + 'services/' + incontactConf.version + '/contacts/chats/' + auth.chatSessionId + '/send-text': // post-/contacts/chats/{chatSession}/send-text
          return httpCodeErrors;
        default:
          return {};
      }
    };

    /*
     * Generic message on unexpected inContact session error
     * Message can be customized in SDKconf -> labels
     */
    function genericError () {
      return chatbot.actions.displaySystemMessage({
        translate: true,
        message: 'alert-title',
        id: 'incontact-error',
        options: [{
          label: 'alert-button',
          value: 'try-again'
        }]
      });
    }

    /*
     * Display a chatbot "Enter your question" message (after inContat session is closed, manually or on error)
     * Message can be customized in SDKconf -> labels
     */
    function enterQuestion () {
      return chatbot.actions.displayChatbotMessage({
        type: 'answer',
        message: 'enter-question',
        translate: true
      });
    }

    /*
     * Close inContact session, remove InContact cookies, diplay an "Agent left" message, set default chatbotIcon
     * Message can be customized in SDKconf -> labels
     */
    function agentLeft () {
      incontactSessionOn = false;
      chatbot.actions.displaySystemMessage({
        message: 'agent-left',
        replacements: { agentName: incontactConf.agent.name },
        translate: true
      });
      chatbot.actions.setChatbotIcon({ source: 'default' });
      chatbot.actions.setChatbotName({ source: 'default' });
      removeIncontactCookies(['inbentaIncontactActive', 'incontactAccessToken', 'incontactResourceBaseUrl', 'incontactChatSessionId']);
      enterQuestion();
    }

    /*
     * Get chatbot conversation mesages and prepare them to be sent to InContact agent
     */
    var retrieveLastMessages = function () {
      var transcript = chatbot.actions.getConversationTranscript();
      transcript.unshift({ message: '--INBENTA PREVIOUS USER/CHATBOT CONVERSATION--', user: 'system' });
      sendMultipleMessagesToIncontact(transcript);
      auth.timers.getChatText = setTimeout(getChatText, incontactConf.getMessageTimeout);
    };

    /*
     *
     * CHATBOT SUBSCIPTIONS
     *
     */

    // Initiate escalation to inContact
    chatbot.subscriptions.onEscalateToAgent(function (escalateData, next) {
      chatbot.actions.displaySystemMessage({ message: 'wait-for-agent', translate: true }); // Message can be customized in SDKconf -> labels
      chatbot.actions.displayChatbotActivity();
      chatbot.actions.disableInput();
      connectToIncontact(); // No escalateData is passed
    });

    // Route messages to inContact
    chatbot.subscriptions.onSendMessage(function (messageData, next) {
      if (incontactSessionOn) {
        sendMessageToIncontact(messageData.message, 'Client', true);
      } else {
        return next(messageData);
      }
    });

    var agentIconSet = false;
    // Show custom agent's picture
    chatbot.subscriptions.onDisplayChatbotMessage(function (messageData, next) {
      if (incontactSessionOn && incontactConf.agent && !agentIconSet) {
        if (incontactConf.agent.avatarImage !== '') chatbot.actions.setChatbotIcon({ source: 'url', url: incontactConf.agent.avatarImage });
        if (incontactConf.agent.name !== '') chatbot.actions.setChatbotName({ source: 'name', name: incontactConf.agent.name });
        agentIconSet = true;
      }
      return next(messageData);
    });

    // Handle generic error
    chatbot.subscriptions.onSelectSystemMessageOption(function (optionData, next) {
      if (optionData.option.value === 'try-again') {
        enterQuestion();
      } else {
        return next(optionData);
      }
    });

    // Finish looking for agents Timeout
    chatbot.subscriptions.onResetSession(function (next) {
      clearTimeout(auth.timers.noAgents);
      clearTimeout(auth.timers.getChatText);
      return next();
    });

    // Handle inContact session/no-session on refresh
    chatbot.subscriptions.onReady(function (next) {
      if (IncontactSession.get('inbentaIncontactActive')) {
        auth.accessToken = IncontactSession.get('incontactAccessToken');
        auth.resourceBaseUrl = IncontactSession.get('incontactResourceBaseUrl');
        auth.chatSessionId = IncontactSession.get('incontactChatSessionId');
        incontactSessionOn = true;
        auth.closedOnTimeout = false;
        getChatProfile();
        auth.timers.getChatText = setTimeout(getChatText, incontactConf.getMessageTimeout);
      } else {
        removeIncontactCookies(['inbentaIncontactActive', 'incontactAccessToken', 'incontactResourceBaseUrl', 'incontactChatSessionId']);
      }
    });

    // Clear inContact chatSession on exitConversation
    chatbot.subscriptions.onSelectSystemMessageOption(function (optionData, next) {
      if (optionData.id === 'exitConversation' && optionData.option.value === 'yes' && incontactSessionOn === true) {
        removeIncontactCookies(['inbentaIncontactActive', 'incontactAccessToken', 'incontactResourceBaseUrl', 'incontactChatSessionId']);
        incontactSessionOn = false;
        auth.closedOnTimeout = true;
        clearTimeout(auth.timers.getChatText);
        endChatSession();
        chatbot.actions.setChatbotIcon({ source: 'default' });
        chatbot.actions.setChatbotName({ source: 'default' });
        chatbot.actions.displaySystemMessage({
          message: 'chat-closed', // Message can be customized in SDKconf -> labels
          translate: true
        });
        enterQuestion();
      } else {
        return next(optionData);
      }
    });

    // DATA KEYS LOG
    // Contact Attended log on agent join conversation system message
    chatbot.subscriptions.onDisplaySystemMessage(function (messageData, next) {
      if (messageData.message === 'agent-joined') {
        chatbot.api.track('CONTACT_ATTENDED', { value: 'TRUE' });
      }
      return next(messageData);
    });
    // Contact Unattended log on no agent available system message
    chatbot.subscriptions.onDisplaySystemMessage(function (messageData, next) {
      if (messageData.message === 'no-agents') {
        chatbot.api.track('CONTACT_UNATTENDED', { value: 'TRUE' });
      }
      return next(messageData);
    });
  }
}

/**
 *
 * HELPER: Returns Promise resolving to dummy Object { agentsAvailable: true }
 *
 */
var inbentaPromiseAgentsAvailableTrue = function () {
  return new Promise(function (resolve, reject) {
    resolve({ agentsAvailable: true });
  });
}
