const runtimeConfig = window.CODEX_CHAT_CONFIG || {};
const supabaseUrl = normalizeBaseUrl(runtimeConfig.supabaseUrl || "");
const supabaseAnonKey = runtimeConfig.supabaseAnonKey || "";
const supabaseClient = window.supabase && supabaseUrl && supabaseAnonKey
  ? window.supabase.createClient(supabaseUrl, supabaseAnonKey)
  : null;

const state = {
  currentUser: null,
  session: null,
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
  backendConfigured: Boolean(supabaseClient),
  channel: null
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

  if (!supabaseClient) {
    showAuth();
    showBackendUnavailable();
    return;
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT") {
      logoutLocal();
    }

    if (event === "SIGNED_IN" && session && !state.currentUser) {
      await enterApp(session);
    }
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) {
    showAuth();
    return;
  }

  await enterApp(data.session);
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
  elements.authUsernameLabel.textContent = mode === "register" ? "用户名" : "邮箱";
  elements.authUsername.type = mode === "register" ? "text" : "email";
  elements.authUsername.autocomplete = mode === "register" ? "username" : "email";
  elements.authNote.textContent = mode === "register" ? "注册后请到邮箱中确认账号" : "使用邮箱和密码登录";
  elements.authPassword.autocomplete = mode === "register" ? "new-password" : "current-password";
  elements.authEmail.required = mode === "register";
  elements.authDisplayName.required = mode === "register";
  elements.authMessage.textContent = "";

  if (!state.backendConfigured) {
    showBackendUnavailable();
  }
}

function showBackendUnavailable() {
  elements.authForm.classList.add("is-unconfigured");
  elements.authSubmit.disabled = true;
  elements.authNote.textContent = "后端服务还没有连接，配置完成后即可开放登录和注册。";
  elements.authMessage.textContent = "站点管理员需要在 Netlify 添加 SUPABASE_URL 和 SUPABASE_ANON_KEY，然后重新部署。";
}

async function submitAuth() {
  if (!supabaseClient) return;

  const username = normalizeUsername(elements.authUsername.value);
  const loginEmail = normalizeEmail(elements.authUsername.value);
  const email = normalizeEmail(elements.authEmail.value);
  const displayName = elements.authDisplayName.value.trim();
  const password = elements.authPassword.value;

  elements.authSubmit.disabled = true;
  elements.authMessage.textContent = "";

  try {
    if (state.authMode === "register") {
      await registerWithSupabase({ username, email, displayName, password });
      setAuthMode("login");
      elements.authMessage.textContent = `确认邮件已发送到 ${email}，请先到邮箱中点击确认链接。`;
      return;
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: loginEmail,
      password
    });

    if (error) throw error;
    await enterApp(data.session);
  } catch (error) {
    elements.authMessage.textContent = getFriendlyError(error);
  } finally {
    elements.authSubmit.disabled = false;
  }
}

async function registerWithSupabase({ username, email, displayName, password }) {
  if (!username || username.length < 3) {
    throw new Error("用户名至少需要 3 个字符。");
  }

  if (!isValidEmail(email)) {
    throw new Error("请填写有效的邮箱地址。");
  }

  if (!displayName) {
    throw new Error("请填写昵称。");
  }

  if (password.length < 6) {
    throw new Error("密码至少需要 6 位。");
  }

  const { data: existing, error: lookupError } = await supabaseClient
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) {
    throw new Error("这个用户名已经被使用。");
  }

  const { error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: window.location.origin,
      data: {
        username,
        display_name: displayName,
        avatar: createAvatar(displayName)
      }
    }
  });

  if (error) throw error;
}

async function enterApp(session) {
  if (!session?.user) {
    showAuth();
    return;
  }

  state.session = session;
  state.currentUser = await loadProfile(session.user.id);

  if (!state.currentUser) {
    throw new Error("没有找到用户资料，请稍后再试。");
  }

  showApp();
  renderCurrentUser();
  await updateOwnStatus("online");
  subscribeRealtime();

  await Promise.all([loadConversations(), loadFriends()]);

  if (!state.activeConversationId && state.conversations.length > 0) {
    await openConversation(state.conversations[0].id);
  }
}

async function loadProfile(userId) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ? serializeUser(data) : null;
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
  await updateOwnStatus("offline");
  await supabaseClient.auth.signOut();
  logoutLocal();
}

function logoutLocal() {
  unsubscribeRealtime();
  state.session = null;
  state.currentUser = null;
  state.conversations = [];
  state.messages = [];
  state.activeConversationId = null;
  showAuth();
  renderEmptyState();
}

async function updateOwnStatus(status) {
  if (!state.currentUser) return;

  await supabaseClient
    .from("profiles")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", state.currentUser.id);

  state.currentUser.status = status;
  renderCurrentUser();
}

async function loadConversations() {
  const currentUserId = state.currentUser.id;
  const { data: memberRows, error: memberError } = await supabaseClient
    .from("conversation_members")
    .select("conversation_id,user_id,last_read_at,last_read_message_id,pinned,conversations(id,type,created_at)")
    .eq("user_id", currentUserId);

  if (memberError) throw memberError;

  const conversationIds = memberRows.map((row) => row.conversation_id);
  if (conversationIds.length === 0) {
    state.conversations = [];
    renderConversations();
    return;
  }

  const [{ data: allMembers, error: allMembersError }, { data: messages, error: messagesError }] = await Promise.all([
    supabaseClient
      .from("conversation_members")
      .select("conversation_id,user_id,last_read_at,last_read_message_id,pinned,profiles(id,username,display_name,avatar,status,created_at)")
      .in("conversation_id", conversationIds),
    supabaseClient
      .from("messages")
      .select("id,conversation_id,sender_id,text,created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true })
  ]);

  if (allMembersError) throw allMembersError;
  if (messagesError) throw messagesError;

  state.conversations = memberRows
    .map((row) => buildConversationSummary(row, allMembers, messages))
    .filter(Boolean)
    .sort(sortConversations);

  renderConversations();
}

function buildConversationSummary(memberState, allMembers, allMessages) {
  const conversation = memberState.conversations;
  const members = allMembers.filter((row) => row.conversation_id === memberState.conversation_id);
  const contact = members.find((row) => row.user_id !== state.currentUser.id)?.profiles || members[0]?.profiles;
  const messages = allMessages.filter((message) => message.conversation_id === memberState.conversation_id);
  const lastMessage = messages.at(-1) || null;
  const lastReadAt = memberState.last_read_at || "";
  const unread = messages.filter((message) => (
    message.sender_id !== state.currentUser.id && message.created_at > lastReadAt
  )).length;

  return {
    id: memberState.conversation_id,
    type: conversation?.type || "direct",
    contact: serializeUser(contact),
    unread,
    pinned: Boolean(memberState.pinned),
    lastMessage: lastMessage ? serializeMessage(lastMessage, members) : null,
    createdAt: conversation?.created_at
  };
}

async function loadFriends() {
  const currentUserId = state.currentUser.id;
  const { data, error } = await supabaseClient
    .from("friendships")
    .select("id,requester_id,addressee_id,status,created_at,updated_at,requester:profiles!friendships_requester_id_fkey(id,username,display_name,avatar,status,created_at),addressee:profiles!friendships_addressee_id_fkey(id,username,display_name,avatar,status,created_at)")
    .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`)
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const friends = [];
  const incoming = [];
  const outgoing = [];

  data.forEach((row) => {
    if (row.status === "accepted") {
      friends.push({
        ...serializeUser(row.requester_id === currentUserId ? row.addressee : row.requester),
        friendshipId: row.id
      });
      return;
    }

    if (row.addressee_id === currentUserId) {
      incoming.push({ ...serializeUser(row.requester), friendshipId: row.id });
    } else {
      outgoing.push({ ...serializeUser(row.addressee), friendshipId: row.id });
    }
  });

  state.friends = { friends, incoming, outgoing };
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
  const username = normalizeUsername(elements.friendInput.value);
  if (!username) return;

  elements.friendMessage.textContent = "";

  try {
    const { data: target, error: targetError } = await supabaseClient
      .from("profiles")
      .select("id,username,display_name,avatar,status,created_at")
      .eq("username", username)
      .maybeSingle();

    if (targetError) throw targetError;
    if (!target || target.id === state.currentUser.id) {
      throw new Error("没有找到这个用户。");
    }

    const existing = [...state.friends.friends, ...state.friends.incoming, ...state.friends.outgoing]
      .some((friend) => friend.id === target.id);

    if (existing) {
      throw new Error("你们已经有好友关系或待处理请求。");
    }

    const { error } = await supabaseClient
      .from("friendships")
      .insert({
        requester_id: state.currentUser.id,
        addressee_id: target.id,
        status: "pending"
      });

    if (error) throw error;

    elements.friendInput.value = "";
    elements.friendMessage.textContent = "好友请求已发送。";
    await loadFriends();
  } catch (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
  }
}

async function acceptFriend(userId) {
  try {
    const { error } = await supabaseClient
      .from("friendships")
      .update({ status: "accepted", updated_at: new Date().toISOString() })
      .eq("requester_id", userId)
      .eq("addressee_id", state.currentUser.id);

    if (error) throw error;

    await Promise.all([loadFriends(), loadConversations()]);
  } catch (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
  }
}

async function openFriendConversation(friend) {
  const { data, error } = await supabaseClient.rpc("create_direct_conversation", {
    other_user_id: friend.id
  });

  if (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
    return;
  }

  setView("chats");
  await loadConversations();
  await openConversation(data);
}

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  elements.appShell.classList.add("chat-open");
  renderConversations();

  state.messages = await listMessages(conversationId);
  const active = state.conversations.find((conversation) => conversation.id === conversationId);

  if (active) {
    renderActiveHeader(active);
  }

  renderMessages();
  renderConversations();
  await markRead(conversationId);
  elements.messageInput.focus();
}

async function listMessages(conversationId) {
  const [{ data: messages, error: messagesError }, { data: members, error: membersError }] = await Promise.all([
    supabaseClient
      .from("messages")
      .select("id,conversation_id,sender_id,text,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("conversation_members")
      .select("conversation_id,user_id,last_read_at,last_read_message_id,profiles(id,username,display_name,avatar,status,created_at)")
      .eq("conversation_id", conversationId)
  ]);

  if (messagesError) throw messagesError;
  if (membersError) throw membersError;

  return messages.map((message) => serializeMessage(message, members));
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
    const { data, error } = await supabaseClient
      .from("messages")
      .insert({
        conversation_id: state.activeConversationId,
        sender_id: state.currentUser.id,
        text
      })
      .select("id,conversation_id,sender_id,text,created_at")
      .single();

    if (error) throw error;

    const members = await getConversationMembers(state.activeConversationId);
    appendMessage(serializeMessage(data, members));
    elements.messageInput.value = "";
    autosizeTextarea();
    renderMessages();
    await loadConversations();
  } catch (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
  } finally {
    updateSendState();
  }
}

async function getConversationMembers(conversationId) {
  const { data, error } = await supabaseClient
    .from("conversation_members")
    .select("conversation_id,user_id,last_read_at,last_read_message_id,profiles(id,username,display_name,avatar,status,created_at)")
    .eq("conversation_id", conversationId);

  if (error) throw error;
  return data;
}

async function markRead(conversationId) {
  if (!conversationId) return;

  const lastMessage = state.messages.at(-1);
  const { error } = await supabaseClient
    .from("conversation_members")
    .update({
      last_read_message_id: lastMessage?.id || null,
      last_read_at: new Date().toISOString()
    })
    .eq("conversation_id", conversationId)
    .eq("user_id", state.currentUser.id);

  if (!error) {
    await loadConversations();
  }
}

function subscribeRealtime() {
  unsubscribeRealtime();

  state.channel = supabaseClient
    .channel("codex-chat-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, refreshRealtimeData)
    .subscribe((status) => {
      setConnectionState(status === "SUBSCRIBED" ? "online" : "offline");
    });
}

function unsubscribeRealtime() {
  if (state.channel) {
    supabaseClient.removeChannel(state.channel);
    state.channel = null;
  }
}

async function refreshRealtimeData(payload) {
  if (!state.currentUser) return;

  await Promise.all([loadFriends(), loadConversations()]);

  if (state.activeConversationId) {
    state.messages = await listMessages(state.activeConversationId);
    renderMessages();

    if (payload.table === "messages" && payload.new?.sender_id !== state.currentUser.id) {
      await markRead(state.activeConversationId);
    }
  }
}

function appendMessage(message) {
  if (state.messages.some((item) => item.id === message.id)) return;
  state.messages.push(message);
  state.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function serializeMessage(message, members) {
  const senderProfile = members.find((member) => member.user_id === message.sender_id)?.profiles;
  const readBy = members
    .filter((member) => (
      member.user_id !== message.sender_id
      && member.last_read_at
      && member.last_read_at >= message.created_at
    ))
    .map((member) => serializeUser(member.profiles));

  return {
    id: message.id,
    conversationId: message.conversation_id,
    senderId: message.sender_id,
    sender: serializeUser(senderProfile),
    text: message.text,
    createdAt: message.created_at,
    readBy
  };
}

function serializeUser(profile) {
  if (!profile) {
    return {
      id: "",
      username: "unknown",
      name: "未知用户",
      avatar: "?"
    };
  }

  return {
    id: profile.id,
    username: profile.username,
    name: profile.display_name,
    avatar: profile.avatar,
    status: profile.status || "offline",
    createdAt: profile.created_at
  };
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

function sortConversations(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return new Date(getConversationDate(b)) - new Date(getConversationDate(a));
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

function createAvatar(displayName) {
  return Array.from(displayName).slice(0, 2).join("").toUpperCase();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getFriendlyError(error) {
  const message = error?.message || String(error);

  if (message.includes("Invalid login credentials")) {
    return "邮箱或密码不正确。";
  }

  if (message.includes("Email not confirmed")) {
    return "请先到邮箱中点击确认链接。";
  }

  if (message.includes("duplicate key")) {
    return "这个用户名或邮箱已经被使用。";
  }

  return message;
}
