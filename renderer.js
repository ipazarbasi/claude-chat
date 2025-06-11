const { ipcRenderer } = require("electron");
const { Anthropic } = require("@anthropic-ai/sdk");
const { marked } = require("marked");
const { markedHighlight } = require("marked-highlight");
const hljs = require("highlight.js");

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

// Initialize the app
async function init() {
  try {
    apiKey = await ipcRenderer.invoke("get-api-key");
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

      // Try to load the last active chat or the newest one
      // We'll need to store lastActiveChatId or determine it. For now, let's load the newest.
      const chatIds = Object.keys(chatHistory).sort(
        (a, b) => parseInt(b) - parseInt(a)
      ); // Sort by newest first
      if (chatIds.length > 0) {
        currentChatId = chatIds[0]; // Load the most recent chat
        loadChat(currentChatId);
      } else {
        // This case should ideally not be reached if storedHistory has keys
        await createNewChat();
      }
    } else {
      // No existing chats or empty history object, create a new one
      await createNewChat();
    }

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
  searchChatsInput.addEventListener('input', () => {
    updateChatHistorySidebar(); // Re-render sidebar with filter
  });

  ipcRenderer.on("export-chat", exportChat);
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

  // Save the updated chat history (with the new empty chat)
  await saveCurrentChatHistory();
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
  if (!chatHistory[chatId]) return;

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
        displayAssistantMessage(msg.content);
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

  // Optional: Add a confirmation dialog
  // if (!confirm(`Are you sure you want to delete "${chatHistory[chatIdToDelete].title}"?`)) {
  //   return;
  // }

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

// Send message
async function sendMessage() {
  const message = userInput.value.trim();
  if (!message || !apiKey || isWaitingForResponse) return;

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
      // Call Claude API
      const response = await anthropicClient.messages.create({
        model: selectedModel,
        max_tokens: 64000,
        messages: chatHistory[currentChatId].messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
        system:
          "You are Claude, an AI assistant made by Anthropic. You're running in a custom Electron chat app.",
      });

      // Remove loading indicator
      chatMessages.removeChild(loadingElement);

      // Process and display the response
      const assistantResponse = response.content[0].text;
      displayAssistantMessage(assistantResponse);

      // Add assistant message to chat history
      chatHistory[currentChatId].messages.push({
        role: "assistant",
        content: assistantResponse,
      });
      await saveCurrentChatHistory(); // Save after adding assistant's message
    } catch (error) {
      // Remove loading indicator
      chatMessages.removeChild(loadingElement);

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
  messageElement.innerHTML = `
    <div class="message-bubble user-bubble">
      <div class="message-header">You</div>
      <div class="message-text">${message}</div>
    </div>
  `;

  // Remove welcome message if it exists
  const welcomeMessage = document.querySelector(".welcome-message");
  if (welcomeMessage) {
    chatMessages.removeChild(welcomeMessage);
  }

  chatMessages.appendChild(messageElement);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Display assistant message
function displayAssistantMessage(message) {
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

  // Add copy buttons to code blocks
  const codeBlocks = messageElement.querySelectorAll("pre code");
  codeBlocks.forEach((codeBlock, index) => {
    const pre = codeBlock.parentNode;

    // Create wrapper div
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Add copy button
    const copyButton = document.createElement("button");
    copyButton.className = "code-copy-btn";
    copyButton.textContent = "Copy";
    copyButton.dataset.index = index;

    copyButton.addEventListener("click", () => {
      const code = codeBlock.textContent;
      navigator.clipboard
        .writeText(code)
        .then(() => {
          copyButton.textContent = "Copied!";
          setTimeout(() => {
            copyButton.textContent = "Copy";
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

// Start the app
document.addEventListener("DOMContentLoaded", init);
