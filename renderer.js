const { ipcRenderer } = require("electron");
const { Anthropic } = require("@anthropic-ai/sdk");
const { marked } = require("marked");
const { markedHighlight } = require("marked-highlight");
const hljs = require("highlight.js");
const DOMPurify = require("dompurify");

// Configure marked with syntax highlighting
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

// Global variables
let anthropicClient = null;
let apiKey = null;
let selectedModel = "claude-3-7-sonnet-latest";
let currentChatId = null;
let chatHistory = {};
let isWaitingForResponse = false;
let foundMatches = [];
let currentMatchIndex = -1;

// Model configuration with max_tokens and beta headers
const MODEL_CONFIG = {
  "claude-opus-4-20250514": {
    maxTokens: 8192,
    betaHeaders: {}
  },
  "claude-sonnet-4-20250514": {
    maxTokens: 8192,
    betaHeaders: {}
  },
  "claude-3-7-sonnet-latest": {
    maxTokens: 128000,
    betaHeaders: {
      "anthropic-beta": "output-128k-2025-02-19"
    }
  },
  "claude-3-7-sonnet-20250219": {
    maxTokens: 128000,
    betaHeaders: {
      "anthropic-beta": "output-128k-2025-02-19"
    }
  },
  "claude-3-5-sonnet-20241022": {
    maxTokens: 8192,
    betaHeaders: {
      "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"
    }
  },
  "claude-3-5-sonnet-20240620": {
    maxTokens: 8192,
    betaHeaders: {
      "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"
    }
  },
  "claude-3-5-sonnet-latest": {
    maxTokens: 8192,
    betaHeaders: {
      "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"
    }
  },
  "claude-3-opus-20240229": {
    maxTokens: 4096,
    betaHeaders: {}
  },
  "claude-3-opus-latest": {
    maxTokens: 4096,
    betaHeaders: {}
  },
  "claude-3-5-haiku-20241022": {
    maxTokens: 4096,
    betaHeaders: {}
  },
  "claude-3-5-haiku-latest": {
    maxTokens: 4096,
    betaHeaders: {}
  },
  "claude-3-haiku-20240307": {
    maxTokens: 4096,
    betaHeaders: {}
  }
};

// DOM Elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-message");
const newChatButton = document.getElementById("new-chat");
const settingsModal = document.getElementById("settings-modal");
const openSettingsButton = document.getElementById("open-settings");
const closeSettingsButton = document.getElementById("close-settings");
const saveSettingsButton = document.getElementById("save-settings");
const apiKeyInput = document.getElementById("api-key");
const modelSelect = document.getElementById("model-select");
const chatHistoryContainer = document.getElementById("chat-history");
const exportChatButton = document.getElementById("export-chat-btn");
const searchChatsInput = document.getElementById("search-chats-input");
const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findResultsCount = document.getElementById("find-results-count");
const findPrevBtn = document.getElementById("find-prev-btn");
const findNextBtn = document.getElementById("find-next-btn");
const findWholeWordCheckbox =
  document.getElementById("find-whole-word-checkbox");
const findCloseBtn = document.getElementById("find-close-btn");

// Initialize the app
async function init() {
  try {
    apiKey = await ipcRenderer.invoke("get-api-key");
    
    // Load saved model selection
    const savedModel = await ipcRenderer.invoke("get-selected-model");
    if (savedModel) {
      selectedModel = savedModel;
      modelSelect.value = savedModel;
    }
    
    if (apiKey) {
      initializeAnthropicClient(apiKey);
      apiKeyInput.value = apiKey;
      sendButton.disabled = false;
    } else {
      settingsModal.style.display = "flex";
    }

    // Load chat history
    const storedHistory = await ipcRenderer.invoke("get-chat-history");
    if (storedHistory && Object.keys(storedHistory).length > 0) {
      chatHistory = storedHistory;
      updateChatHistorySidebar();
      // Even if history exists, start with a new chat as per new requirement
      await createNewChat();
    } else {
      // No existing chats, create a new one
      await createNewChat();
    }
    // Ensure a new chat is created if, for some reason, chatHistory was loaded but createNewChat wasn't hit.
    // Or, simply always create a new chat after loading history for the sidebar.

    setupEventListeners();
  } catch (error) {
    console.error("Initialization error:", error);
    displayError(
      "Failed to initialize the application. Please check your settings."
    );
  }
}

// Initialize Anthropic client
function initializeAnthropicClient(key) {
  try {
    anthropicClient = new Anthropic({
      apiKey: key,
    });
  } catch (error) {
    console.error("Failed to initialize Anthropic client:", error);
    displayError(
      "Failed to initialize Anthropic client. Please check your API key."
    );
  }
}

// Set up event listeners
function setupEventListeners() {
  // Send message on button click or Enter key (without shift)
  sendButton.addEventListener("click", sendMessage);
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Enable/disable send button based on input
  userInput.addEventListener("input", () => {
    sendButton.disabled =
      !userInput.value.trim() || !apiKey || isWaitingForResponse;
  });

  // New chat button
  newChatButton.addEventListener("click", async () => await createNewChat());

  // Settings modal
  openSettingsButton.addEventListener("click", () => {
    settingsModal.style.display = "flex";
  });

  closeSettingsButton.addEventListener("click", () => {
    settingsModal.style.display = "none";
  });

  saveSettingsButton.addEventListener("click", saveSettings);

  // Model selection
  modelSelect.addEventListener("change", (e) => {
    selectedModel = e.target.value;
  });

  // Export chat
  exportChatButton.addEventListener("click", exportChat);

  // Listen for menu events
  ipcRenderer.on("open-settings", () => {
    settingsModal.style.display = "flex";
  });

  // Search input listener
  searchChatsInput.addEventListener("input", () => {
    updateChatHistorySidebar(); // Re-render sidebar with filter
  });

  ipcRenderer.on("export-chat", exportChat);

  // --- Find in page listeners ---
  ipcRenderer.on("open-find", openFindBar);

  findCloseBtn.addEventListener("click", closeFindBar);

  findInput.addEventListener("input", performFind);
  findWholeWordCheckbox.addEventListener("change", performFind);

  findNextBtn.addEventListener("click", () => {
    if (foundMatches.length > 0) {
      navigateToMatch((currentMatchIndex + 1) % foundMatches.length);
    }
  });

  findPrevBtn.addEventListener("click", () => {
    if (foundMatches.length > 0) {
      navigateToMatch(
        (currentMatchIndex - 1 + foundMatches.length) % foundMatches.length
      );
    }
  });

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevBtn.click();
      } else {
        findNextBtn.click();
      }
    }
  });

  // Global listener to close find bar with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && findBar.style.display !== "none") {
      closeFindBar();
    }
  });
}

// Save chat history to store
async function saveCurrentChatHistory() {
  try {
    await ipcRenderer.invoke("save-chat-history", chatHistory);
  } catch (error) {
    console.error("Failed to save chat history:", error);
    // Optionally, display a non-intrusive error message to the user
  }
}

// Create a new chat
async function createNewChat() {
  closeFindBar(); // Close find bar for a new chat
  const previousChatId = currentChatId; // Store current before overwriting
  cleanupPreviousEmptyNewChat(previousChatId); // Clean up if previous was an empty new chat

  // Generate a unique ID for this chat
  currentChatId = Date.now().toString();

  // Add to chat history object
  chatHistory[currentChatId] = {
    title: "New Chat",
    messages: [],
  };

  // Update chat history sidebar
  updateChatHistorySidebar();

  // Clear chat messages and show welcome for the new chat
  chatMessages.innerHTML = ""; // Clear previous content
  const welcomeMessageDiv = document.createElement("div");
  welcomeMessageDiv.className = "welcome-message";
  welcomeMessageDiv.innerHTML = `
    <h1>Chat: ${chatHistory[currentChatId].title}</h1>
    <p>This chat is empty. Start a conversation by typing your message below.</p>
  `;
  chatMessages.appendChild(welcomeMessageDiv);

  // Clear input
  userInput.value = "";
  userInput.focus();
}

// Update the chat history sidebar
function updateChatHistorySidebar() {
  chatHistoryContainer.innerHTML = "";
  const searchTerm = searchChatsInput.value.trim().toLowerCase();

  // Sort chat IDs by timestamp (newest first) before filtering
  const sortedChatIds = Object.keys(chatHistory).sort(
    (a, b) => parseInt(b) - parseInt(a)
  );

  sortedChatIds.forEach((chatId) => {
    const chat = chatHistory[chatId];
    let isMatch = false;

    if (!searchTerm) {
      isMatch = true; // Show all if search term is empty
    } else {
      // Check title
      if (chat.title.toLowerCase().includes(searchTerm)) {
        isMatch = true;
      }
      // Check messages if title didn't match
      if (!isMatch) {
        for (const message of chat.messages) {
          if (message.content.toLowerCase().includes(searchTerm)) {
            isMatch = true;
            break; // Found a match in messages
          }
        }
      }
    }

    if (isMatch) {
      const chatItem = document.createElement("div");
      chatItem.className = `chat-item-container ${
        chatId === currentChatId ? "active" : ""
      }`;
      chatItem.dataset.chatId = chatId;

      const titleSpan = document.createElement("span");
      titleSpan.className = "chat-item-title";
      titleSpan.textContent = chat.title;
      titleSpan.addEventListener("click", () => {
        loadChat(chatId);
      });

      const deleteButton = document.createElement("button");
      deleteButton.className = "chat-item-delete-btn";
      deleteButton.innerHTML = "&#10005;"; // Cross mark
      deleteButton.title = "Delete Chat";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation(); // Prevent chatItem click event
        deleteChat(chatId);
      });

      chatItem.appendChild(titleSpan);
      chatItem.appendChild(deleteButton);
      chatHistoryContainer.appendChild(chatItem);
    }
  });
}

// Load a chat from history
function loadChat(chatId) {
  // No longer needs to be async
  if (!chatHistory[chatId] || currentChatId === chatId) return;
  closeFindBar(); // Close find bar when loading another chat

  const previousChatId = currentChatId;
  if (previousChatId !== chatId) {
    // Only cleanup if switching to a different chat
    cleanupPreviousEmptyNewChat(previousChatId);
  }

  currentChatId = chatId;
  updateChatHistorySidebar();

  chatMessages.innerHTML = "";

  const currentChat = chatHistory[chatId];
  if (currentChat.messages.length === 0) {
    // If the chat is empty, show a welcome/info message for this specific chat
    const welcomeMessageDiv = document.createElement("div");
    welcomeMessageDiv.className = "welcome-message";
    welcomeMessageDiv.innerHTML = `
      <h1>Chat: ${currentChat.title}</h1>
      <p>This chat is empty. Start a conversation by typing your message below.</p>
    `;
    chatMessages.appendChild(welcomeMessageDiv);
  } else {
    // Display all messages
    currentChat.messages.forEach((msg) => {
      if (msg.role === "user") {
        displayUserMessage(msg.content);
      } else {
        displayAssistantMessage(msg.content, msg.stop_reason === "max_tokens");
      }
    });
  }
  userInput.focus();
}

// Save settings
async function saveSettings() {
  const newApiKey = apiKeyInput.value.trim();
  selectedModel = modelSelect.value;

  if (newApiKey) {
    try {
      await ipcRenderer.invoke("save-api-key", newApiKey);
      await ipcRenderer.invoke("save-selected-model", selectedModel);
      apiKey = newApiKey;
      initializeAnthropicClient(apiKey);
      sendButton.disabled = false;
      settingsModal.style.display = "none";
    } catch (error) {
      console.error("Failed to save settings:", error);
      displayError("Failed to save settings. Please try again.");
    }
  } else {
    displayError("API key cannot be empty.");
  }
}

// Delete a chat from history
async function deleteChat(chatIdToDelete) {
  if (!chatHistory[chatIdToDelete]) return;

  if (
    !confirm(
      `Are you sure you want to delete "${chatHistory[chatIdToDelete].title}"?`
    )
  ) {
    return;
  }

  const isDeletingCurrentChat = currentChatId === chatIdToDelete;

  delete chatHistory[chatIdToDelete];
  await saveCurrentChatHistory();

  if (isDeletingCurrentChat) {
    currentChatId = null;
    const remainingChatIds = Object.keys(chatHistory).sort(
      (a, b) => parseInt(b) - parseInt(a)
    );
    if (remainingChatIds.length > 0) {
      loadChat(remainingChatIds[0]); // Load the newest remaining chat
    } else {
      await createNewChat(); // Create a new chat if none are left
    }
  } else {
    // If we deleted a non-active chat, just refresh the sidebar
    // The active chat remains the same, so no need to call loadChat()
    updateChatHistorySidebar();
  }
}

// Helper function to remove an empty "New Chat" if it was not interacted with
function cleanupPreviousEmptyNewChat(chatIdToClean) {
  if (
    chatIdToClean &&
    chatHistory[chatIdToClean] &&
    chatHistory[chatIdToClean].messages.length === 0 &&
    chatHistory[chatIdToClean].title === "New Chat" // Check if it's still the default "New Chat"
  ) {
    delete chatHistory[chatIdToClean];
    // The sidebar will be updated by the calling function (loadChat or createNewChat)
    // which typically calls updateChatHistorySidebar() after this.
    // If not, and immediate sidebar update is needed here, uncomment:
    // updateChatHistorySidebar();
  }
}

// Send message
async function sendMessage() {
  const message = userInput.value;
  // Validate using the trimmed value, but use the raw value to preserve whitespace.
  if (!message.trim() || !apiKey || isWaitingForResponse) {
    return;
  }

  try {
    // Display user message
    displayUserMessage(message);

    // Disable input during processing
    isWaitingForResponse = true;
    userInput.value = "";
    sendButton.disabled = true;

    // Add user message to chat history
    chatHistory[currentChatId].messages.push({
      role: "user",
      content: message,
    });

    // Update the chat title if this is the first message
    if (chatHistory[currentChatId].messages.length === 1) {
      chatHistory[currentChatId].title =
        message.substring(0, 30) + (message.length > 30 ? "..." : "");
      updateChatHistorySidebar();
    }
    await saveCurrentChatHistory(); // Save after adding user message and updating title

    // Add loading indicator
    const loadingElement = document.createElement("div");
    loadingElement.className = "message assistant-message";
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
      // Get model-specific configuration
      const modelConfig = MODEL_CONFIG[selectedModel] || {
        maxTokens: 4096,
        betaHeaders: {}
      };

      // Prepare API call options
      const apiOptions = {
        model: selectedModel,
        max_tokens: modelConfig.maxTokens,
        stream: true,
        messages: chatHistory[currentChatId].messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        system:
          "You are Claude, an AI assistant made by Anthropic. You're running in a custom Electron chat app.",
      };

      // Remove loading indicator and create streaming message container
      chatMessages.removeChild(loadingElement);
      const { messageElement, textElement } = createStreamingAssistantMessage();
      
      let fullResponse = "";
      let stopReason = null;

      // Add beta headers if required for the model
      if (Object.keys(modelConfig.betaHeaders).length > 0) {
        // Handle streaming for models with beta headers (raw fetch)
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            ...modelConfig.betaHeaders
          },
          body: JSON.stringify(apiOptions)
        });

        if (!resp.ok) {
          const errorData = await resp.json();
          throw {
            status: resp.status,
            response: { data: errorData }
          };
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta') {
                  const textDelta = parsed.delta.text;
                  if (textDelta) {
                    fullResponse += textDelta;
                    updateStreamingMessage(textElement, fullResponse);
                  }
                } else if (parsed.type === 'message_delta') {
                  stopReason = parsed.delta.stop_reason;
                }
              } catch (e) {
                // Skip invalid JSON
              }
            }
          }
        }
      } else {
        // Handle streaming for models without beta headers (SDK)
        const stream = await anthropicClient.messages.stream(apiOptions);

        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta') {
            const textDelta = chunk.delta.text;
            if (textDelta) {
              fullResponse += textDelta;
              updateStreamingMessage(textElement, fullResponse);
            }
          } else if (chunk.type === 'message_stop') {
            stopReason = chunk.message?.stop_reason;
          }
        }
      }

      // Finalize the streaming message
      finalizeStreamingMessage(messageElement, stopReason === "max_tokens");

      // Add assistant message to chat history
      chatHistory[currentChatId].messages.push({
        role: "assistant",
        content: fullResponse,
        stop_reason: stopReason,
      });
      await saveCurrentChatHistory(); // Save after adding assistant's message
    } catch (error) {
      // Remove loading indicator or streaming message if they exist
      try {
        if (loadingElement && chatMessages.contains(loadingElement)) {
          chatMessages.removeChild(loadingElement);
        }
      } catch (e) {
        // Loading element might already be removed, ignore
      }

      // Handle API errors
      console.error("API Error:", error);
      let errorMessage = "An error occurred while communicating with Claude.";

      if (error.status === 401) {
        errorMessage = "Invalid API key. Please check your settings.";
      } else if (error.status === 400) {
        errorMessage =
          "Bad request: " +
          (error.response?.data?.error?.message || "Unknown error");
      } else if (error.status === 429) {
        errorMessage = "Rate limit exceeded. Please try again later.";
      } else if (error.status >= 500) {
        errorMessage =
          "Claude service is currently unavailable. Please try again later.";
      }

      displayError(errorMessage);
    }
  } catch (error) {
    console.error("Error sending message:", error);
    displayError("Failed to send message. Please try again.");
  } finally {
    isWaitingForResponse = false;
    sendButton.disabled = !userInput.value.trim() || !apiKey;
  }
}

// Display user message
function displayUserMessage(message) {
  const messageElement = document.createElement("div");
  messageElement.className = "message user-message";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble user-bubble";

  const header = document.createElement("div");
  header.className = "message-header";
  header.textContent = "You";

  const text = document.createElement("div");
  text.className = "message-text";
  // Render user's message as markdown, but sanitize it first to prevent XSS.
  text.innerHTML = DOMPurify.sanitize(marked(message));

  bubble.appendChild(header);
  bubble.appendChild(text);
  messageElement.appendChild(bubble);

  // Remove welcome message if it exists
  const welcomeMessage = document.querySelector(".welcome-message");
  if (welcomeMessage) {
    chatMessages.removeChild(welcomeMessage);
  }

  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Display assistant message
function displayAssistantMessage(message, wasTruncated = false) {
  const messageElement = document.createElement("div");
  messageElement.className = "message assistant-message";

  // Process markdown
  const renderedMarkdown = marked(message);

  messageElement.innerHTML = `
    <div class="message-bubble assistant-bubble">
      <div class="message-header">Claude</div>
      <div class="message-text">${renderedMarkdown}</div>
    </div>
  `;

  chatMessages.appendChild(messageElement);

  // Add a persistent warning if the message was truncated by the API
  if (wasTruncated) {
    const warningElement = document.createElement("div");
    warningElement.className = "warning-message";
    warningElement.textContent =
      "Warning: This response was truncated by the API because it reached the maximum token limit.";
    // Append it inside the bubble for better association with the message
    messageElement.querySelector(".message-bubble").appendChild(warningElement);
  }

  // Add copy buttons to code blocks
  const codeBlocks = messageElement.querySelectorAll("pre code");
  codeBlocks.forEach((codeBlock) => {
    const pre = codeBlock.parentNode;

    // Create wrapper div
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Add copy button
    const copyButton = document.createElement("button");
    copyButton.className = "code-copy-btn";
    const copyIconSVG = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display: block; margin: auto;">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>`;
    copyButton.innerHTML = copyIconSVG;
    copyButton.title = "Copy code";

    copyButton.addEventListener("click", () => {
      const code = codeBlock.textContent;
      navigator.clipboard
        .writeText(code)
        .then(() => {
          copyButton.textContent = "Copied!";
          setTimeout(() => {
            copyButton.innerHTML = copyIconSVG;
          }, 2000);
        })
        .catch((err) => {
          console.error("Failed to copy code:", err);
        });
    });

    wrapper.insertBefore(copyButton, pre);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Create streaming assistant message container
function createStreamingAssistantMessage() {
  const messageElement = document.createElement("div");
  messageElement.className = "message assistant-message";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble assistant-bubble";

  const header = document.createElement("div");
  header.className = "message-header";
  header.textContent = "Claude";

  const text = document.createElement("div");
  text.className = "message-text";

  bubble.appendChild(header);
  bubble.appendChild(text);
  messageElement.appendChild(bubble);

  // Remove welcome message if it exists
  const welcomeMessage = document.querySelector(".welcome-message");
  if (welcomeMessage) {
    chatMessages.removeChild(welcomeMessage);
  }

  chatMessages.appendChild(messageElement);
  return { messageElement, textElement: text };
}

// Update streaming message content
function updateStreamingMessage(textElement, content) {
  // Process markdown
  const renderedMarkdown = marked(content);
  textElement.innerHTML = renderedMarkdown;
  
  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Finalize streaming message (add copy buttons, etc.)
function finalizeStreamingMessage(messageElement, wasTruncated = false) {
  // Add a persistent warning if the message was truncated by the API
  if (wasTruncated) {
    const warningElement = document.createElement("div");
    warningElement.className = "warning-message";
    warningElement.textContent =
      "Warning: This response was truncated by the API because it reached the maximum token limit.";
    // Append it inside the bubble for better association with the message
    messageElement.querySelector(".message-bubble").appendChild(warningElement);
  }

  // Add copy buttons to code blocks
  const codeBlocks = messageElement.querySelectorAll("pre code");
  codeBlocks.forEach((codeBlock) => {
    const pre = codeBlock.parentNode;

    // Create wrapper div
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Add copy button
    const copyButton = document.createElement("button");
    copyButton.className = "code-copy-btn";
    const copyIconSVG = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display: block; margin: auto;">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>`;
    copyButton.innerHTML = copyIconSVG;
    copyButton.title = "Copy code";

    copyButton.addEventListener("click", () => {
      const code = codeBlock.textContent;
      navigator.clipboard
        .writeText(code)
        .then(() => {
          copyButton.textContent = "Copied!";
          setTimeout(() => {
            copyButton.innerHTML = copyIconSVG;
          }, 2000);
        })
        .catch((err) => {
          console.error("Failed to copy code:", err);
        });
    });

    wrapper.insertBefore(copyButton, pre);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Display error message
function displayError(message) {
  const errorElement = document.createElement("div");
  errorElement.className = "error-message";
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
    displayError("No chat to export.");
    return;
  }

  try {
    // Convert chat to markdown
    let markdown = `# ${chatHistory[currentChatId].title}\n\n`;
    markdown += `Exported on ${new Date().toLocaleString()}\n\n`;

    chatHistory[currentChatId].messages.forEach((msg) => {
      if (msg.role === "user") {
        markdown += `## You\n\n${msg.content}\n\n`;
      } else {
        markdown += `## Claude\n\n${msg.content}\n\n`;
      }
    });

    // Open save dialog
    const result = await ipcRenderer.invoke("export-chat-dialog", markdown);

    if (result.success) {
      // Show temporary success message
      const successElement = document.createElement("div");
      successElement.style.cssText =
        "background-color: #e8f5e9; color: #2e7d32; padding: 12px; margin-bottom: 12px; border-radius: 4px;";
      successElement.textContent = `Chat exported to ${result.path}`;

      chatMessages.appendChild(successElement);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      setTimeout(() => {
        if (chatMessages.contains(successElement)) {
          chatMessages.removeChild(successElement);
        }
      }, 5000);
    } else if (result.error !== "Export cancelled") {
      displayError(`Failed to export chat: ${result.error}`);
    }
  } catch (error) {
    console.error("Export error:", error);
    displayError("Failed to export chat. Please try again.");
  }
}

// --- Find in Page Functions ---

function openFindBar() {
  findBar.style.display = "flex";
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findBar.style.display = "none";
  findInput.value = "";
  clearHighlights();
}

function clearHighlights() {
  const marks = chatMessages.querySelectorAll("mark");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize(); // Merges adjacent text nodes
    }
  });
  foundMatches = [];
  currentMatchIndex = -1;
  updateFindResultsCount();
}

function performFind() {
  clearHighlights();
  const searchTerm = findInput.value;
  if (!searchTerm) {
    updateFindResultsCount();
    return;
  }

  const wholeWord = findWholeWordCheckbox.checked;
  // Escape special regex characters in the search term
  const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = wholeWord ? `\\b${escapedTerm}\\b` : escapedTerm;
  const regex = new RegExp(pattern, "gi"); // g: global, i: case-insensitive

  const messageTexts = chatMessages.querySelectorAll(".message-text");
  const matches = [];

  messageTexts.forEach((container) => {
    // Walk the DOM to find text nodes, avoiding modification of the HTML structure
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      // Don't search in scripts or styles if they exist, or inside our own marks
      if (
        node.parentNode.tagName !== "SCRIPT" &&
        node.parentNode.tagName !== "STYLE" &&
        node.parentNode.tagName !== "MARK"
      ) {
        nodes.push(node);
      }
    }

    nodes.forEach((textNode) => {
      const text = textNode.textContent;
      const localMatches = [...text.matchAll(regex)];

      if (localMatches.length > 0) {
        const parent = textNode.parentNode;
        let lastIndex = 0;

        localMatches.forEach((match) => {
          const foundText = match[0];
          const startIndex = match.index;

          if (startIndex > lastIndex) {
            parent.insertBefore(
              document.createTextNode(text.substring(lastIndex, startIndex)),
              textNode
            );
          }

          const mark = document.createElement("mark");
          mark.textContent = foundText;
          matches.push(mark);
          parent.insertBefore(mark, textNode);

          lastIndex = startIndex + foundText.length;
        });

        if (lastIndex < text.length) {
          parent.insertBefore(
            document.createTextNode(text.substring(lastIndex)),
            textNode
          );
        }

        parent.removeChild(textNode);
      }
    });
  });

  foundMatches = matches;
  updateFindResultsCount();

  if (foundMatches.length > 0) {
    navigateToMatch(0);
  }
}

function updateFindResultsCount() {
  if (findInput.value && foundMatches.length > 0) {
    findResultsCount.textContent = `${currentMatchIndex + 1} of ${
      foundMatches.length
    }`;
  } else if (findInput.value) {
    findResultsCount.textContent = "0 of 0";
  } else {
    findResultsCount.textContent = "";
  }
}

function navigateToMatch(index) {
  if (currentMatchIndex > -1 && foundMatches[currentMatchIndex]) {
    foundMatches[currentMatchIndex].classList.remove("current-match");
  }

  currentMatchIndex = index;

  if (currentMatchIndex > -1 && foundMatches[currentMatchIndex]) {
    const currentMatchElement = foundMatches[currentMatchIndex];
    currentMatchElement.classList.add("current-match");
    currentMatchElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
  updateFindResultsCount();
}

// Start the app
document.addEventListener("DOMContentLoaded", init);
