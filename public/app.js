const tokenKey = "codex-chat-token";
const runtimeConfig = window.CODEX_CHAT_CONFIG || {};
const apiBaseUrl = normalizeBaseUrl(runtimeConfig.apiBaseUrl || "");
const wsBaseUrl = normalizeBaseUrl(runtimeConfig.wsBaseUrl || "");

const state = {
  token: localStorage.getItem(tokenKey),
  currentUser: null,
  conversations: [],
  friends: {
    friends: [],
    incoming: [],
    outgoing: []
  },
  activeConversationId: null,
  messages: [],
  searchTerm: "",
  view: "chats",
  authMode: "login",
  socket: null,
  reconnectTimer: null
};

const elements = {
  authScreen: document.querySelector("#authScreen"),
  authForm: document.querySelector("#authForm"),
  authUsername: document.querySelector("#authUsername"),
  authUsernameLabel: document.querySelector("#authUsernameLabel"),
  authEmail: document.querySelector("#authEmail"),
  authDisplayName: document.querySelector("#authDisplayName"),
  authPassword: document.querySelector("#authPassword"),
  authSubmit: document.querySelector("#authSubmit"),
  authNote: document.querySelector("#authNote"),
  authMessage: document.querySelector("#authMessage"),
  appShell: document.querySelector("#appShell"),
  currentUserAvatar: document.querySelector("#currentUserAvatar"),
  currentUserName: document.querySelector("#currentUserName"),
  logoutButton: document.querySelector("#logoutButton"),
  searchInput: document.querySelector("#searchInput"),
  chatsTab: document.querySelector("#chatsTab"),
  friendsTab: document.querySelector("#friendsTab"),
  conversationList: document.querySelector("#conversationList"),
  friendsPanel: document.querySelector("#friendsPanel"),
  friendForm: document.querySelector("#friendForm"),
  friendInput: document.querySelector("#friendInput"),
  friendList: document.querySelector("#friendList"),
  incomingRequests: document.querySelector("#incomingRequests"),
  outgoingRequests: document.querySelector("#outgoingRequests"),
  friendMessage: document.querySelector("#friendMessage"),
  activeAvatar: document.querySelector("#activeAvatar"),
  activeName: document.querySelector("#activeName"),
  activeStatus: document.querySelector("#activeStatus"),
  connectionState: document.querySelector("#connectionState"),
  messageStream: document.querySelector("#messageStream"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  backButton: document.querySelector("#backButton")
};

bindEvents();
boot();

async function boot() {
  renderEmptyState();
  setConnectionState("offline");

  if (!state.token) {
    showAuth();
    return;
  }

  try {
    const payload = await requestJson("/api/me");
    await enterApp(payload.user);
  } catch {
    logoutLocal();
  }
}

function bindEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAuth();
  });

  elements.logoutButton.addEventListener("click", logout);

  elements.searchInput.addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    renderConversations();
    renderFriends();
  });

  elements.chatsTab.addEventListener("click", () => setView("chats"));
  elements.friendsTab.addEventListener("click", () => setView("friends"));

  elements.friendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendFriendRequest();
  });

  elements.messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  elements.messageInput.addEventListener("input", () => {
    autosizeTextarea();
    updateSendState();
  });

  elements.messageInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendMessage();
    }
  });

  elements.backButton.addEventListener("click", () => {
    elements.appShell.classList.remove("chat-open");
  });

  window.addEventListener("focus", () => {
    if (state.activeConversationId) {
      markRead(state.activeConversationId);
    }
  });

  updateSendState();
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === mode);
  });

  elements.authForm.classList.toggle("is-register", mode === "register");
  elements.authSubmit.textContent = mode === "register" ? "注册" : "登录";
  elements.authUsernameLabel.textContent = mode === "register" ? "用户名" : "邮箱或用户名";
  elements.authNote.textContent = mode === "register" ? "注册后需要先到邮箱中确认" : "演示账号：iwen / 123456";
  elements.authPassword.autocomplete = mode === "register" ? "new-password" : "current-password";
  elements.authEmail.required = mode === "register";
  elements.authDisplayName.required = mode === "register";
  elements.authMessage.textContent = "";
}

async function submitAuth() {
  const username = elements.authUsername.value.trim();
  const email = elements.authEmail.value.trim();
  const displayName = elements.authDisplayName.value.trim();
  const password = elements.authPassword.value;
  const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";

  elements.authSubmit.disabled = true;
  elements.authMessage.textContent = "";

  try {
    const payload = await requestJson(endpoint, {
      method: "POST",
      body: JSON.stringify({ username, email, displayName, password })
    });

    if (payload.requiresVerification) {
      setAuthMode("login");
      elements.authMessage.textContent = payload.message || `确认邮件已发送到 ${payload.email}，请先到邮箱中确认。`;
      return;
    }

    state.token = payload.token;
    localStorage.setItem(tokenKey, payload.token);
    await enterApp(payload.user);
  } catch (error) {
    elements.authMessage.textContent = error.message;
  } finally {
    elements.authSubmit.disabled = false;
  }
}

async function enterApp(user) {
  state.currentUser = user;
  showApp();
  renderCurrentUser();
  connectSocket();

  await Promise.all([loadConversations(), loadFriends()]);

  if (!state.activeConversationId && state.conversations.length > 0) {
    await openConversation(state.conversations[0].id);
  }
}

function showAuth() {
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
  setAuthMode(state.authMode);
  elements.authUsername.focus();
}

function showApp() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  setView(state.view);
}

async function logout() {
  try {
    await requestJson("/api/auth/logout", { method: "POST" });
  } catch {
    // A local logout is still useful if the token already expired.
  }

  logoutLocal();
}

function logoutLocal() {
  closeSocket();
  localStorage.removeItem(tokenKey);
  state.token = null;
  state.currentUser = null;
  state.conversations = [];
  state.messages = [];
  state.activeConversationId = null;
  showAuth();
  renderEmptyState();
}

async function loadConversations() {
  const payload = await requestJson("/api/conversations");
  state.currentUser = payload.currentUser;
  state.conversations = payload.conversations;
  renderCurrentUser();
  renderConversations();
}

async function loadFriends() {
  state.friends = await requestJson("/api/friends");
  renderFriends();
}

function renderCurrentUser() {
  if (!state.currentUser) return;

  elements.currentUserAvatar.textContent = state.currentUser.avatar;
  elements.currentUserName.textContent = `${state.currentUser.name} · ${statusLabel(state.currentUser.status)}`;
}

function setView(view) {
  state.view = view;
  elements.chatsTab.classList.toggle("active", view === "chats");
  elements.friendsTab.classList.toggle("active", view === "friends");
  elements.conversationList.hidden = view !== "chats";
  elements.friendsPanel.hidden = view !== "friends";
  elements.searchInput.placeholder = view === "chats" ? "搜索会话或消息" : "搜索好友";

  if (view === "friends") {
    renderFriends();
  } else {
    renderConversations();
  }
}

function renderConversations() {
  const conversations = getFilteredConversations();
  elements.conversationList.replaceChildren();

  if (conversations.length === 0) {
    elements.conversationList.append(createEmptyBlock("还没有会话", "去好友页添加好友后开始聊天。"));
    return;
  }

  conversations.forEach((conversation) => {
    const contact = conversation.contact;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "conversation-item";
    item.dataset.id = conversation.id;

    if (conversation.id === state.activeConversationId) {
      item.classList.add("active");
    }

    const lastText = conversation.lastMessage?.text || "还没有消息";
    const time = conversation.lastMessage
      ? `<time datetime="${conversation.lastMessage.createdAt}">${formatShortTime(conversation.lastMessage.createdAt)}</time>`
      : "";

    item.innerHTML = `
      <div class="avatar">${escapeHtml(contact.avatar)}</div>
      <div class="conversation-main">
        <div class="conversation-top">
          <strong>${escapeHtml(contact.name)}</strong>
          ${time}
        </div>
        <div class="conversation-meta">
          <span>${escapeHtml(lastText)}</span>
        </div>
      </div>
      <div class="conversation-side">
        <span class="status-dot ${contact.status}" title="${statusLabel(contact.status)}"></span>
        ${conversation.unread ? `<span class="unread-badge">${conversation.unread}</span>` : ""}
      </div>
    `;

    item.addEventListener("click", () => openConversation(conversation.id));
    elements.conversationList.append(item);
  });
}

function renderFriends() {
  const term = state.searchTerm;
  const friends = state.friends.friends.filter((friend) => matchUser(friend, term));
  const incoming = state.friends.incoming.filter((friend) => matchUser(friend, term));
  const outgoing = state.friends.outgoing.filter((friend) => matchUser(friend, term));

  elements.friendList.replaceChildren();
  elements.incomingRequests.replaceChildren();
  elements.outgoingRequests.replaceChildren();

  if (incoming.length > 0) {
    elements.incomingRequests.append(createSectionTitle("待处理请求"));
    incoming.forEach((friend) => {
      const row = createUserRow(friend, "接受", () => acceptFriend(friend.id));
      elements.incomingRequests.append(row);
    });
  }

  elements.friendList.append(createSectionTitle("好友"));
  if (friends.length === 0) {
    elements.friendList.append(createEmptyBlock("暂无好友", "输入用户名发送好友请求。"));
  } else {
    friends.forEach((friend) => {
      const row = createUserRow(friend, "聊天", () => openFriendConversation(friend));
      elements.friendList.append(row);
    });
  }

  if (outgoing.length > 0) {
    elements.outgoingRequests.append(createSectionTitle("已发送"));
    outgoing.forEach((friend) => {
      const row = createUserRow(friend, "等待", null);
      elements.outgoingRequests.append(row);
    });
  }
}

function createUserRow(user, actionLabel, action) {
  const row = document.createElement("article");
  row.className = "user-row";
  row.innerHTML = `
    <div class="avatar">${escapeHtml(user.avatar)}</div>
    <div>
      <strong>${escapeHtml(user.name)}</strong>
      <span>@${escapeHtml(user.username)} · ${statusLabel(user.status)}</span>
    </div>
  `;

  const button = document.createElement("button");
  button.className = "secondary-button";
  button.type = "button";
  button.textContent = actionLabel;
  button.disabled = !action;

  if (action) {
    button.addEventListener("click", action);
  }

  row.append(button);
  return row;
}

function createSectionTitle(text) {
  const title = document.createElement("h3");
  title.className = "section-title";
  title.textContent = text;
  return title;
}

function createEmptyBlock(title, detail) {
  const block = document.createElement("div");
  block.className = "empty-state compact-empty";
  block.innerHTML = `<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>`;
  return block;
}

async function sendFriendRequest() {
  const username = elements.friendInput.value.trim();
  if (!username) return;

  elements.friendMessage.textContent = "";

  try {
    state.friends = await requestJson("/api/friends/request", {
      method: "POST",
      body: JSON.stringify({ username })
    });
    elements.friendInput.value = "";
    elements.friendMessage.textContent = "好友请求已发送。";
    renderFriends();
  } catch (error) {
    elements.friendMessage.textContent = error.message;
  }
}

async function acceptFriend(userId) {
  try {
    state.friends = await requestJson(`/api/friends/${userId}/accept`, { method: "POST" });
    await Promise.all([loadConversations(), loadFriends()]);
  } catch (error) {
    elements.friendMessage.textContent = error.message;
  }
}

async function openFriendConversation(friend) {
  const payload = await requestJson("/api/conversations/direct", {
    method: "POST",
    body: JSON.stringify({ userId: friend.id })
  });

  upsertConversation(payload.conversation);
  setView("chats");
  await openConversation(payload.conversation.id);
}

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  elements.appShell.classList.add("chat-open");
  renderConversations();

  const payload = await requestJson(`/api/conversations/${conversationId}/messages`);
  upsertConversation(payload.conversation);
  state.messages = payload.messages;
  renderActiveHeader(payload.conversation);
  renderMessages();
  renderConversations();
  await markRead(conversationId);
  elements.messageInput.focus();
}

function renderActiveHeader(conversation) {
  const contact = conversation.contact;
  elements.activeAvatar.textContent = contact.avatar;
  elements.activeName.textContent = contact.name;
  elements.activeStatus.textContent = `@${contact.username} · ${statusLabel(contact.status)}`;
}

function renderMessages() {
  elements.messageStream.replaceChildren();

  if (state.messages.length === 0) {
    elements.messageStream.append(createEmptyBlock("还没有消息", "发出第一条消息吧。"));
    return;
  }

  state.messages.forEach((message) => {
    const row = document.createElement("article");
    const isMe = message.senderId === state.currentUser.id;
    const receipt = isMe ? (message.readBy?.length ? "已读" : "送达") : "";
    row.className = `message-row${isMe ? " me" : ""}`;
    row.innerHTML = `
      <div class="message-bubble">
        <p>${escapeHtml(message.text)}</p>
        <time datetime="${message.createdAt}">${formatMessageTime(message.createdAt)}${receipt ? ` · ${receipt}` : ""}</time>
      </div>
    `;
    elements.messageStream.append(row);
  });

  elements.messageStream.scrollTop = elements.messageStream.scrollHeight;
}

function renderEmptyState() {
  elements.messageStream.innerHTML = `
    <div class="empty-state">
      <div>
        <strong>选择会话开始聊天</strong>
        <span>最近会话和好友聊天会显示在这里。</span>
      </div>
    </div>
  `;
}

async function sendMessage() {
  const text = elements.messageInput.value.trim();

  if (!text || !state.activeConversationId) {
    return;
  }

  elements.sendButton.disabled = true;

  try {
    const payload = await requestJson(`/api/conversations/${state.activeConversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text })
    });

    appendMessage(payload.message);
    upsertConversation(payload.conversation);
    elements.messageInput.value = "";
    autosizeTextarea();
    renderMessages();
    renderConversations();
  } catch (error) {
    elements.friendMessage.textContent = error.message;
  } finally {
    updateSendState();
  }
}

async function markRead(conversationId) {
  if (!conversationId) return;

  try {
    const payload = await requestJson(`/api/conversations/${conversationId}/read`, { method: "POST" });
    upsertConversation(payload.conversation);
    renderConversations();
  } catch {
    // The next successful load will refresh unread counts.
  }
}

function connectSocket() {
  closeSocket(false);

  if (!state.token || !window.WebSocket) return;

  const fallbackProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socketOrigin = wsBaseUrl || `${fallbackProtocol}://${window.location.host}`;
  const socket = new WebSocket(`${socketOrigin}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    setConnectionState("online");
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    handleSocketPayload(payload);
  });

  socket.addEventListener("close", () => {
    setConnectionState("offline");
    if (state.token) {
      state.reconnectTimer = window.setTimeout(connectSocket, 1600);
    }
  });

  socket.addEventListener("error", () => {
    setConnectionState("offline");
  });
}

function closeSocket(clearTimer = true) {
  if (clearTimer && state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function handleSocketPayload(payload) {
  if (payload.type === "socket:ready") {
    state.currentUser = payload.user;
    renderCurrentUser();
    return;
  }

  if (payload.type === "message:new") {
    upsertConversation(payload.conversation);

    if (payload.conversationId === state.activeConversationId) {
      appendMessage(payload.message);
      renderMessages();

      if (payload.message.senderId !== state.currentUser.id) {
        markRead(payload.conversationId);
      }
    }

    renderConversations();
    return;
  }

  if (payload.type === "conversation:read") {
    applyReadReceipt(payload);
    return;
  }

  if (payload.type === "friend:request" || payload.type === "friend:accepted") {
    loadFriends();
    loadConversations();
    return;
  }

  if (payload.type === "presence:update") {
    applyPresence(payload.user);
  }
}

function applyReadReceipt(payload) {
  if (payload.user.id === state.currentUser.id && payload.conversation) {
    upsertConversation(payload.conversation);
    renderConversations();
  }

  if (payload.conversationId !== state.activeConversationId || payload.user.id === state.currentUser.id) {
    return;
  }

  state.messages = state.messages.map((message) => {
    if (message.senderId !== state.currentUser.id || new Date(message.createdAt) > new Date(payload.readAt)) {
      return message;
    }

    const exists = message.readBy.some((user) => user.id === payload.user.id);
    return exists ? message : { ...message, readBy: [...message.readBy, payload.user] };
  });

  renderMessages();
}

function applyPresence(user) {
  state.conversations = state.conversations.map((conversation) => {
    if (conversation.contact.id !== user.id) return conversation;
    return { ...conversation, contact: { ...conversation.contact, status: user.status } };
  });

  for (const key of ["friends", "incoming", "outgoing"]) {
    state.friends[key] = state.friends[key].map((friend) => {
      if (friend.id !== user.id) return friend;
      return { ...friend, status: user.status };
    });
  }

  const active = state.conversations.find((conversation) => conversation.id === state.activeConversationId);
  if (active) {
    renderActiveHeader(active);
  }

  renderCurrentUser();
  renderConversations();
  renderFriends();
}

function appendMessage(message) {
  if (state.messages.some((item) => item.id === message.id)) return;
  state.messages.push(message);
  state.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function upsertConversation(conversation) {
  if (!conversation) return;

  const index = state.conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) {
    state.conversations[index] = conversation;
  } else {
    state.conversations.unshift(conversation);
  }

  state.conversations.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(getConversationDate(b)) - new Date(getConversationDate(a));
  });
}

function getFilteredConversations() {
  const term = state.searchTerm;

  return state.conversations.filter((conversation) => {
    if (!term) return true;

    const haystack = [
      conversation.contact.name,
      conversation.contact.username,
      conversation.lastMessage?.text || ""
    ].join(" ").toLowerCase();

    return haystack.includes(term);
  });
}

function matchUser(user, term) {
  if (!term) return true;
  return `${user.name} ${user.username}`.toLowerCase().includes(term);
}

async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (state.token) {
    headers.set("Authorization", `Bearer ${state.token}`);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  const payload = parseJsonResponse(text, response, path);

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      logoutLocal();
    }
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseJsonResponse(text, response, path) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get("Content-Type") || "";
    const looksLikeHtml = contentType.includes("text/html") || text.trimStart().startsWith("<");

    if (looksLikeHtml && path.startsWith("/api/") && !apiBaseUrl) {
      throw new Error("当前 Netlify 只部署了前端，还没有连接后端 API。请先部署 Node 后端，并在 Netlify 设置 API_BASE_URL 和 WS_BASE_URL。");
    }

    if (looksLikeHtml && path.startsWith("/api/")) {
      throw new Error("后端地址返回了网页而不是 JSON，请检查 API_BASE_URL 是否指向真正的 Node 后端。");
    }

    throw new Error("服务器返回格式不正确，请稍后再试。");
  }
}

function autosizeTextarea() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${elements.messageInput.scrollHeight}px`;
}

function updateSendState() {
  elements.sendButton.disabled = !state.activeConversationId || elements.messageInput.value.trim().length === 0;
}

function setConnectionState(stateName) {
  elements.connectionState.textContent = stateName === "online" ? "实时在线" : "离线";
  elements.connectionState.classList.toggle("online", stateName === "online");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getConversationDate(conversation) {
  return conversation.lastMessage?.createdAt || conversation.createdAt || new Date(0).toISOString();
}

function formatShortTime(value) {
  const date = new Date(value);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function formatMessageTime(value) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusLabel(status) {
  const labels = {
    online: "在线",
    away: "离开",
    offline: "离线"
  };

  return labels[status] || "未知";
}
