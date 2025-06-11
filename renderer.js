const { ipcRenderer } = require('electron');
const { Anthropic } = require('@anthropic-ai/sdk');
const { marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const hljs = require('highlight.js');

// Configure marked with syntax highlighting
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  }
}));

// Global variables
let anthropicClient = null;
let apiKey = null;
let selectedModel = 'claude-3-7-sonnet-latest';
let currentChatId = null;
let chatHistory = {};
let isWaitingForResponse = false;

// DOM Elements
const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendButton = document.getElementById('send-message');
const newChatButton = document.getElementById('new-chat');
const settingsModal = document.getElementById('settings-modal');
const openSettingsButton = document.getElementById('open-settings');
const closeSettingsButton = document.getElementById('close-settings');
const saveSettingsButton = document.getElementById('save-settings');
const apiKeyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model-select');
const chatHistoryContainer = document.getElementById('chat-history');
const exportChatButton = document.getElementById('export-chat-btn');

// Initialize the app
async function init() {
  try {
    // Load API key from storage
    apiKey = await ipcRenderer.invoke('get-api-key');

    if (apiKey) {
      initializeAnthropicClient(apiKey);
      apiKeyInput.value = apiKey;
      sendButton.disabled = false;
    } else {
      // Show settings modal if no API key is found
      settingsModal.style.display = 'flex';
    }

    // Create a new chat session
    createNewChat();

    // Set up event listeners
    setupEventListeners();
  } catch (error) {
    console.error('Initialization error:', error);
    displayError('Failed to initialize the application. Please check your settings.');
  }
}

// Initialize Anthropic client
function initializeAnthropicClient(key) {
  try {
    anthropicClient = new Anthropic({
      apiKey: key
    });
  } catch (error) {
    console.error('Failed to initialize Anthropic client:', error);
    displayError('Failed to initialize Anthropic client. Please check your API key.');
  }
}

// Set up event listeners
function setupEventListeners() {
  // Send message on button click or Enter key (without shift)
  sendButton.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Enable/disable send button based on input
  userInput.addEventListener('input', () => {
    sendButton.disabled = !userInput.value.trim() || !apiKey || isWaitingForResponse;
  });

  // New chat button
  newChatButton.addEventListener('click', createNewChat);

  // Settings modal
  openSettingsButton.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
  });

  closeSettingsButton.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  saveSettingsButton.addEventListener('click', saveSettings);

  // Model selection
  modelSelect.addEventListener('change', (e) => {
    selectedModel = e.target.value;
  });

  // Export chat
  exportChatButton.addEventListener('click', exportChat);

  // Listen for menu events
  ipcRenderer.on('open-settings', () => {
    settingsModal.style.display = 'flex';
  });

  ipcRenderer.on('export-chat', exportChat);
}

// Create a new chat
function createNewChat() {
  // Generate a unique ID for this chat
  currentChatId = Date.now().toString();

  // Add to chat history object
  chatHistory[currentChatId] = {
    title: 'New Chat',
    messages: []
  };

  // Update chat history sidebar
  updateChatHistorySidebar();

  // Clear chat messages
  chatMessages.innerHTML = `
    <div class="welcome-message">
      <h1>Welcome to Claude Chat</h1>
      <p>Start a conversation with Claude by typing your message below.</p>
    </div>
  `;

  // Clear input
  userInput.value = '';
  userInput.focus();
}

// Update the chat history sidebar
function updateChatHistorySidebar() {
  chatHistoryContainer.innerHTML = '';

  Object.keys(chatHistory).forEach(chatId => {
    const chat = chatHistory[chatId];
    const chatItem = document.createElement('div');
    chatItem.className = `chat-item ${chatId === currentChatId ? 'active' : ''}`;
    chatItem.textContent = chat.title;
    chatItem.dataset.chatId = chatId;

    chatItem.addEventListener('click', () => {
      loadChat(chatId);
    });

    chatHistoryContainer.appendChild(chatItem);
  });
}

// Load a chat from history
function loadChat(chatId) {
  if (!chatHistory[chatId]) return;

  currentChatId = chatId;
  updateChatHistorySidebar();

  // Clear current chat
  chatMessages.innerHTML = '';

  // Display all messages
  chatHistory[chatId].messages.forEach(msg => {
    if (msg.role === 'user') {
      displayUserMessage(msg.content);
    } else {
      displayAssistantMessage(msg.content);
    }
  });
}

// Save settings
async function saveSettings() {
  const newApiKey = apiKeyInput.value.trim();
  selectedModel = modelSelect.value;

  if (newApiKey) {
    try {
      await ipcRenderer.invoke('save-api-key', newApiKey);
      apiKey = newApiKey;
      initializeAnthropicClient(apiKey);
      sendButton.disabled = false;
      settingsModal.style.display = 'none';
    } catch (error) {
      console.error('Failed to save settings:', error);
      displayError('Failed to save settings. Please try again.');
    }
  } else {
    displayError('API key cannot be empty.');
  }
}

// Send message
async function sendMessage() {
  const message = userInput.value.trim();
  if (!message || !apiKey || isWaitingForResponse) return;

  try {
    // Display user message
    displayUserMessage(message);

    // Disable input during processing
    isWaitingForResponse = true;
    userInput.value = '';
    sendButton.disabled = true;

    // Add user message to chat history
    chatHistory[currentChatId].messages.push({
      role: 'user',
      content: message
    });

    // Update the chat title if this is the first message
    if (chatHistory[currentChatId].messages.length === 1) {
      chatHistory[currentChatId].title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
      updateChatHistorySidebar();
    }

    // Add loading indicator
    const loadingElement = document.createElement('div');
    loadingElement.className = 'message assistant-message';
    loadingElement.innerHTML = `
      <div class="message-bubble assistant-bubble loading-indicator">
        <span class="spinner"></span>
        <span>Claude is thinking...</span>
      </div>
    `;
    chatMessages.appendChild(loadingElement);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
      // Call Claude API
      const response = await anthropicClient.messages.create({
        model: selectedModel,
        max_tokens: 64000,
        messages: chatHistory[currentChatId].messages.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        system: "You are Claude, an AI assistant made by Anthropic. You're running in a custom Electron chat app."
      });

      // Remove loading indicator
      chatMessages.removeChild(loadingElement);

      // Process and display the response
      const assistantResponse = response.content[0].text;
      displayAssistantMessage(assistantResponse);

      // Add assistant message to chat history
      chatHistory[currentChatId].messages.push({
        role: 'assistant',
        content: assistantResponse
      });

    } catch (error) {
      // Remove loading indicator
      chatMessages.removeChild(loadingElement);

      // Handle API errors
      console.error('API Error:', error);
      let errorMessage = 'An error occurred while communicating with Claude.';

      if (error.status === 401) {
        errorMessage = 'Invalid API key. Please check your settings.';
      } else if (error.status === 400) {
        errorMessage = 'Bad request: ' + (error.response?.data?.error?.message || 'Unknown error');
      } else if (error.status === 429) {
        errorMessage = 'Rate limit exceeded. Please try again later.';
      } else if (error.status >= 500) {
        errorMessage = 'Claude service is currently unavailable. Please try again later.';
      }

      displayError(errorMessage);
    }

  } catch (error) {
    console.error('Error sending message:', error);
    displayError('Failed to send message. Please try again.');
  } finally {
    isWaitingForResponse = false;
    sendButton.disabled = !userInput.value.trim();
  }
}

// Display user message
function displayUserMessage(message) {
  const messageElement = document.createElement('div');
  messageElement.className = 'message user-message';
  messageElement.innerHTML = `
    <div class="message-bubble user-bubble">
      <div class="message-header">You</div>
      <div class="message-text">${message}</div>
    </div>
  `;

  // Remove welcome message if it exists
  const welcomeMessage = document.querySelector('.welcome-message');
  if (welcomeMessage) {
    chatMessages.removeChild(welcomeMessage);
  }

  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Display assistant message
function displayAssistantMessage(message) {
  const messageElement = document.createElement('div');
  messageElement.className = 'message assistant-message';

  // Process markdown
  const renderedMarkdown = marked(message);

  messageElement.innerHTML = `
    <div class="message-bubble assistant-bubble">
      <div class="message-header">Claude</div>
      <div class="message-text">${renderedMarkdown}</div>
    </div>
  `;

  chatMessages.appendChild(messageElement);

  // Add copy buttons to code blocks
  const codeBlocks = messageElement.querySelectorAll('pre code');
  codeBlocks.forEach((codeBlock, index) => {
    const pre = codeBlock.parentNode;

    // Create wrapper div
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Add copy button
    const copyButton = document.createElement('button');
    copyButton.className = 'code-copy-btn';
    copyButton.textContent = 'Copy';
    copyButton.dataset.index = index;

    copyButton.addEventListener('click', () => {
      const code = codeBlock.textContent;
      navigator.clipboard.writeText(code).then(() => {
        copyButton.textContent = 'Copied!';
        setTimeout(() => {
          copyButton.textContent = 'Copy';
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy code:', err);
      });
    });

    wrapper.insertBefore(copyButton, pre);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Display error message
function displayError(message) {
  const errorElement = document.createElement('div');
  errorElement.className = 'error-message';
  errorElement.textContent = message;

  chatMessages.appendChild(errorElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Remove error after 5 seconds
  setTimeout(() => {
    if (chatMessages.contains(errorElement)) {
      chatMessages.removeChild(errorElement);
    }
  }, 5000);
}

// Export chat as markdown
async function exportChat() {
  if (!currentChatId || !chatHistory[currentChatId].messages.length) {
    displayError('No chat to export.');
    return;
  }

  try {
    // Convert chat to markdown
    let markdown = `# ${chatHistory[currentChatId].title}\n\n`;
    markdown += `Exported on ${new Date().toLocaleString()}\n\n`;

    chatHistory[currentChatId].messages.forEach(msg => {
      if (msg.role === 'user') {
        markdown += `## You\n\n${msg.content}\n\n`;
      } else {
        markdown += `## Claude\n\n${msg.content}\n\n`;
      }
    });

    // Open save dialog
    const result = await ipcRenderer.invoke('export-chat-dialog', markdown);

    if (result.success) {
      // Show temporary success message
      const successElement = document.createElement('div');
      successElement.style.cssText = 'background-color: #e8f5e9; color: #2e7d32; padding: 12px; margin-bottom: 12px; border-radius: 4px;';
      successElement.textContent = `Chat exported to ${result.path}`;

      chatMessages.appendChild(successElement);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      setTimeout(() => {
        if (chatMessages.contains(successElement)) {
          chatMessages.removeChild(successElement);
        }
      }, 5000);
    } else if (result.error !== 'Export cancelled') {
      displayError(`Failed to export chat: ${result.error}`);
    }
  } catch (error) {
    console.error('Export error:', error);
    displayError('Failed to export chat. Please try again.');
  }
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
