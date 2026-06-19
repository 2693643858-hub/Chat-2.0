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
  activeMembers: [],
  messages: [],
  messageIndex: [],
  attachmentFile: null,
  attachmentUrls: new Map(),
  searchTerm: "",
  view: "chats",
  authMode: "login",
  backendConfigured: Boolean(supabaseClient),
  channel: null,
  typingChannel: null,
  typingUsers: new Map(),
  typingTimers: new Map(),
  lastTypingSentAt: 0
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
  profileButton: document.querySelector("#profileButton"),
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
  groupForm: document.querySelector("#groupForm"),
  groupNameInput: document.querySelector("#groupNameInput"),
  groupMembersInput: document.querySelector("#groupMembersInput"),
  friendList: document.querySelector("#friendList"),
  incomingRequests: document.querySelector("#incomingRequests"),
  outgoingRequests: document.querySelector("#outgoingRequests"),
  friendMessage: document.querySelector("#friendMessage"),
  activeAvatar: document.querySelector("#activeAvatar"),
  activeName: document.querySelector("#activeName"),
  activeStatus: document.querySelector("#activeStatus"),
  pinConversationButton: document.querySelector("#pinConversationButton"),
  muteConversationButton: document.querySelector("#muteConversationButton"),
  connectionState: document.querySelector("#connectionState"),
  messageStream: document.querySelector("#messageStream"),
  typingIndicator: document.querySelector("#typingIndicator"),
  messageForm: document.querySelector("#messageForm"),
  attachmentButton: document.querySelector("#attachmentButton"),
  attachmentInput: document.querySelector("#attachmentInput"),
  attachmentPreview: document.querySelector("#attachmentPreview"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  backButton: document.querySelector("#backButton"),
  profileModal: document.querySelector("#profileModal"),
  profileForm: document.querySelector("#profileForm"),
  profileCloseButton: document.querySelector("#profileCloseButton"),
  profileAvatar: document.querySelector("#profileAvatar"),
  profileDisplayName: document.querySelector("#profileDisplayName"),
  profileBio: document.querySelector("#profileBio"),
  profileStatus: document.querySelector("#profileStatus"),
  profileGender: document.querySelector("#profileGender"),
  profileBirthday: document.querySelector("#profileBirthday"),
  profileHomepage: document.querySelector("#profileHomepage"),
  profileMessage: document.querySelector("#profileMessage")
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
  elements.profileButton.addEventListener("click", openProfileModal);
  elements.profileCloseButton.addEventListener("click", closeProfileModal);
  elements.profileModal.addEventListener("click", (event) => {
    if (event.target === elements.profileModal) closeProfileModal();
  });
  elements.profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveProfile();
  });

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

  elements.groupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createGroupConversation();
  });

  elements.pinConversationButton.addEventListener("click", () => toggleConversationPin());
  elements.muteConversationButton.addEventListener("click", () => toggleConversationMute());

  elements.attachmentButton.addEventListener("click", () => elements.attachmentInput.click());
  elements.attachmentInput.addEventListener("change", () => {
    state.attachmentFile = elements.attachmentInput.files?.[0] || null;
    renderAttachmentPreview();
    updateSendState();
  });

  elements.messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  elements.messageInput.addEventListener("input", () => {
    autosizeTextarea();
    updateSendState();
    announceTyping();
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
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    throw new Error("用户名需要 3-24 位小写字母、数字或下划线。");
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

  if (state.currentUser.status === "offline") {
    await updateOwnStatus("online");
  }

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
  unsubscribeTyping();
  state.session = null;
  state.currentUser = null;
  state.conversations = [];
  state.messages = [];
  state.messageIndex = [];
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

function openProfileModal() {
  if (!state.currentUser) return;

  elements.profileAvatar.value = state.currentUser.avatar || "";
  elements.profileDisplayName.value = state.currentUser.name || "";
  elements.profileBio.value = state.currentUser.bio || "";
  elements.profileStatus.value = state.currentUser.status || "online";
  elements.profileGender.value = state.currentUser.gender || "unspecified";
  elements.profileBirthday.value = state.currentUser.birthday || "";
  elements.profileHomepage.value = state.currentUser.homepage || "";
  elements.profileMessage.textContent = "";
  elements.profileModal.hidden = false;
  elements.profileDisplayName.focus();
}

function closeProfileModal() {
  elements.profileModal.hidden = true;
}

async function saveProfile() {
  const displayName = elements.profileDisplayName.value.trim();
  const avatar = elements.profileAvatar.value.trim() || createAvatar(displayName);

  if (!displayName) {
    elements.profileMessage.textContent = "昵称不能为空。";
    return;
  }

  try {
    const payload = {
      display_name: displayName.slice(0, 32),
      avatar: avatar.slice(0, 8),
      bio: elements.profileBio.value.trim().slice(0, 160),
      status: elements.profileStatus.value,
      gender: elements.profileGender.value,
      birthday: elements.profileBirthday.value || null,
      homepage: elements.profileHomepage.value.trim().slice(0, 180),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabaseClient
      .from("profiles")
      .update(payload)
      .eq("id", state.currentUser.id)
      .select("*")
      .single();

    if (error) throw error;

    state.currentUser = serializeUser(data);
    renderCurrentUser();
    await loadConversations();
    elements.profileMessage.textContent = "已保存。";
    setTimeout(closeProfileModal, 450);
  } catch (error) {
    elements.profileMessage.textContent = getFriendlyError(error);
  }
}

async function loadConversations() {
  const currentUserId = state.currentUser.id;
  const { data: memberRows, error: memberError } = await supabaseClient
    .from("conversation_members")
    .select("conversation_id,user_id,role,nickname,last_read_at,last_read_message_id,pinned,muted_until,archived,joined_at,conversations(id,type,title,avatar,description,announcement,owner_id,settings,created_at,updated_at)")
    .eq("user_id", currentUserId)
    .eq("archived", false);

  if (memberError) throw memberError;

  const conversationIds = memberRows.map((row) => row.conversation_id);
  if (conversationIds.length === 0) {
    state.conversations = [];
    state.messageIndex = [];
    renderConversations();
    return;
  }

  const [{ data: allMembers, error: allMembersError }, { data: messages, error: messagesError }] = await Promise.all([
    supabaseClient
      .from("conversation_members")
      .select("conversation_id,user_id,role,nickname,last_read_at,last_read_message_id,pinned,muted_until,archived,joined_at,profiles(id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at)")
      .in("conversation_id", conversationIds),
    supabaseClient
      .from("messages")
      .select("id,conversation_id,sender_id,text,type,attachment_path,attachment_name,attachment_size,attachment_mime,metadata,recalled_at,created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true })
  ]);

  if (allMembersError) throw allMembersError;
  if (messagesError) throw messagesError;

  state.messageIndex = messages.map((message) => ({
    conversationId: message.conversation_id,
    text: `${message.text || ""} ${message.attachment_name || ""}`.toLowerCase()
  }));

  state.conversations = memberRows
    .map((row) => buildConversationSummary(row, allMembers, messages))
    .filter(Boolean)
    .sort(sortConversations);

  renderConversations();
  renderActiveConversationControls();
}

function buildConversationSummary(memberState, allMembers, allMessages) {
  const conversation = memberState.conversations;
  const members = allMembers.filter((row) => row.conversation_id === memberState.conversation_id);
  const display = getConversationDisplay(conversation, members);
  const messages = allMessages.filter((message) => message.conversation_id === memberState.conversation_id);
  const visibleMessages = messages.filter((message) => !message.recalled_at);
  const lastMessage = visibleMessages.at(-1) || messages.at(-1) || null;
  const lastReadAt = memberState.last_read_at || "";
  const unread = messages.filter((message) => (
    message.sender_id !== state.currentUser.id
    && message.created_at > lastReadAt
    && !message.recalled_at
  )).length;

  return {
    id: memberState.conversation_id,
    type: conversation?.type || "direct",
    title: conversation?.title || "",
    avatar: conversation?.avatar || "",
    announcement: conversation?.announcement || "",
    description: conversation?.description || "",
    role: memberState.role || "member",
    display,
    members,
    memberCount: members.length,
    unread,
    pinned: Boolean(memberState.pinned),
    mutedUntil: memberState.muted_until || null,
    muted: isMuted(memberState.muted_until),
    lastMessage: lastMessage ? serializeMessage(lastMessage, members, null) : null,
    createdAt: conversation?.created_at,
    updatedAt: conversation?.updated_at
  };
}

function getConversationDisplay(conversation, members) {
  if (conversation?.type === "group") {
    const title = conversation.title || "未命名群聊";
    return {
      id: conversation.id,
      username: `${members.length} 位成员`,
      name: title,
      avatar: conversation.avatar || createAvatar(title),
      status: "online"
    };
  }

  const contact = members.find((row) => row.user_id !== state.currentUser.id)?.profiles || members[0]?.profiles;
  return serializeUser(contact);
}

async function loadFriends() {
  const currentUserId = state.currentUser.id;
  const { data, error } = await supabaseClient
    .from("friendships")
    .select("id,requester_id,addressee_id,status,created_at,updated_at,requester:profiles!friendships_requester_id_fkey(id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at),addressee:profiles!friendships_addressee_id_fkey(id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at)")
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
  elements.searchInput.placeholder = view === "chats" ? "搜索会话、群或消息" : "搜索好友";

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
    elements.conversationList.append(createEmptyBlock("还没有会话", "去好友页添加好友或创建群聊。"));
    return;
  }

  conversations.forEach((conversation) => {
    const display = conversation.display;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "conversation-item";
    item.dataset.id = conversation.id;
    item.classList.toggle("active", conversation.id === state.activeConversationId);
    item.classList.toggle("pinned", conversation.pinned);
    item.classList.toggle("muted", conversation.muted);

    const lastText = conversation.lastMessage ? formatMessagePreview(conversation.lastMessage) : "还没有消息";
    const time = conversation.lastMessage
      ? `<time datetime="${conversation.lastMessage.createdAt}">${formatShortTime(conversation.lastMessage.createdAt)}</time>`
      : "";
    const status = conversation.type === "group"
      ? `<span class="status-dot online" title="${conversation.memberCount} 位成员"></span>`
      : `<span class="status-dot ${display.status}" title="${statusLabel(display.status)}"></span>`;

    item.innerHTML = `
      <div class="avatar">${escapeHtml(display.avatar)}</div>
      <div class="conversation-main">
        <div class="conversation-top">
          <strong>${escapeHtml(display.name)}</strong>
          ${time}
        </div>
        <div class="conversation-meta">
          <span>${escapeHtml(lastText)}</span>
        </div>
      </div>
      <div class="conversation-side">
        ${status}
        ${conversation.unread && !conversation.muted ? `<span class="unread-badge">${conversation.unread}</span>` : ""}
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
      <span>@${escapeHtml(user.username)} · ${statusLabel(user.status)}${user.bio ? ` · ${escapeHtml(user.bio)}` : ""}</span>
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
      .select("id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at")
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

async function createGroupConversation() {
  const title = elements.groupNameInput.value.trim();
  const usernames = elements.groupMembersInput.value
    .split(/[\s,，]+/)
    .map(normalizeUsername)
    .filter(Boolean);

  if (!title || usernames.length === 0) {
    elements.friendMessage.textContent = "请填写群名称，并至少输入一个好友用户名。";
    return;
  }

  const members = usernames.map((username) => state.friends.friends.find((friend) => friend.username === username));
  const missing = usernames.filter((username, index) => !members[index]);

  if (missing.length > 0) {
    elements.friendMessage.textContent = `这些用户还不是你的好友：${missing.join("、")}`;
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc("create_group_conversation", {
      group_title: title,
      member_ids: members.map((member) => member.id)
    });

    if (error) throw error;

    elements.groupNameInput.value = "";
    elements.groupMembersInput.value = "";
    elements.friendMessage.textContent = "群聊已创建。";
    setView("chats");
    await loadConversations();
    await openConversation(data);
  } catch (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
  }
}

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  elements.appShell.classList.add("chat-open");
  renderConversations();

  state.messages = await listMessages(conversationId);
  const active = getActiveConversation();

  if (active) {
    renderActiveHeader(active);
  }

  subscribeTyping(conversationId);
  renderMessages();
  renderConversations();
  renderActiveConversationControls();
  await markRead(conversationId);
  elements.messageInput.focus();
}

async function listMessages(conversationId) {
  const [{ data: messages, error: messagesError }, { data: members, error: membersError }] = await Promise.all([
    supabaseClient
      .from("messages")
      .select("id,conversation_id,sender_id,text,type,attachment_path,attachment_name,attachment_size,attachment_mime,metadata,recalled_at,created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("conversation_members")
      .select("conversation_id,user_id,role,nickname,last_read_at,last_read_message_id,profiles(id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at)")
      .eq("conversation_id", conversationId)
  ]);

  if (messagesError) throw messagesError;
  if (membersError) throw membersError;

  state.activeMembers = members;
  const messageIds = messages.map((message) => message.id);
  const { data: actions, error: actionsError } = messageIds.length
    ? await supabaseClient
      .from("message_actions")
      .select("message_id,hidden,favorited")
      .eq("user_id", state.currentUser.id)
      .in("message_id", messageIds)
    : { data: [], error: null };

  if (actionsError) throw actionsError;

  const actionMap = new Map(actions.map((action) => [action.message_id, action]));
  const visible = messages
    .filter((message) => !actionMap.get(message.id)?.hidden)
    .map((message) => serializeMessage(message, members, actionMap.get(message.id)));

  await attachSignedUrls(visible);
  return visible;
}

function renderActiveHeader(conversation) {
  const display = conversation.display;
  elements.activeAvatar.textContent = display.avatar;
  elements.activeName.textContent = display.name;

  if (conversation.type === "group") {
    const note = conversation.announcement || conversation.description || `${conversation.memberCount} 位成员`;
    elements.activeStatus.textContent = `群聊 · ${note}`;
  } else {
    elements.activeStatus.textContent = `@${display.username} · ${statusLabel(display.status)}${display.bio ? ` · ${display.bio}` : ""}`;
  }
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

    const sender = getActiveConversation()?.type === "group" && !isMe
      ? `<p><strong>${escapeHtml(message.sender.name)}</strong></p>`
      : "";
    const recalled = message.recalled ? " recalled" : "";
    const attachment = message.recalled ? "" : renderAttachment(message);
    const text = message.recalled ? "消息已撤回" : escapeHtml(message.text);
    const actions = renderMessageActions(message, isMe);

    row.innerHTML = `
      <div class="message-bubble${recalled}">
        ${sender}
        ${attachment}
        <p>${text}</p>
        <time datetime="${message.createdAt}">${formatMessageTime(message.createdAt)}${receipt ? ` · ${receipt}` : ""}</time>
        ${actions}
      </div>
    `;

    row.querySelectorAll("[data-message-action]").forEach((button) => {
      button.addEventListener("click", () => handleMessageAction(button.dataset.messageAction, message));
    });

    elements.messageStream.append(row);
  });

  elements.messageStream.scrollTop = elements.messageStream.scrollHeight;
}

function renderAttachment(message) {
  if (!message.attachmentPath) return "";

  if (message.type === "image" && message.attachmentUrl) {
    return `
      <div class="message-attachment">
        <a href="${escapeHtml(message.attachmentUrl)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(message.attachmentUrl)}" alt="${escapeHtml(message.attachmentName || "图片")}" />
        </a>
      </div>
    `;
  }

  const href = message.attachmentUrl || "#";
  return `
    <div class="message-attachment">
      <a class="file-card" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">
        <span aria-hidden="true">▣</span>
        <span>
          <strong>${escapeHtml(message.attachmentName || "附件")}</strong>
          <span>${formatFileSize(message.attachmentSize)}</span>
        </span>
      </a>
    </div>
  `;
}

function renderMessageActions(message, isMe) {
  if (message.recalled) return "";

  return `
    <div class="message-actions">
      <button type="button" data-message-action="copy">复制</button>
      <button type="button" data-message-action="favorite">${message.favorited ? "取消收藏" : "收藏"}</button>
      <button type="button" data-message-action="hide">删除</button>
      ${isMe ? `<button type="button" data-message-action="recall">撤回</button>` : ""}
    </div>
  `;
}

async function handleMessageAction(action, message) {
  if (action === "copy") {
    await navigator.clipboard.writeText(message.text || "");
    return;
  }

  if (action === "favorite") {
    await upsertMessageAction(message.id, { favorited: !message.favorited });
    message.favorited = !message.favorited;
    renderMessages();
    return;
  }

  if (action === "hide") {
    await upsertMessageAction(message.id, { hidden: true });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    renderMessages();
    return;
  }

  if (action === "recall") {
    const { error } = await supabaseClient
      .from("messages")
      .update({ recalled_at: new Date().toISOString() })
      .eq("id", message.id)
      .eq("sender_id", state.currentUser.id);

    if (error) throw error;
    message.recalled = true;
    await loadConversations();
    renderMessages();
  }
}

async function upsertMessageAction(messageId, patch) {
  const { error } = await supabaseClient
    .from("message_actions")
    .upsert({
      message_id: messageId,
      user_id: state.currentUser.id,
      ...patch,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "message_id,user_id"
    });

  if (error) throw error;
}

function renderEmptyState() {
  elements.messageStream.innerHTML = `
    <div class="empty-state">
      <div>
        <strong>选择会话开始聊天</strong>
        <span>单聊、群聊、文件和收藏都会显示在这里。</span>
      </div>
    </div>
  `;
}

async function sendMessage() {
  const rawText = elements.messageInput.value.trim();
  const file = state.attachmentFile;

  if ((!rawText && !file) || !state.activeConversationId) {
    return;
  }

  elements.sendButton.disabled = true;

  try {
    let attachment = null;
    if (file) {
      attachment = await uploadAttachment(file);
    }

    const text = rawText || attachment?.name || "";
    const { data, error } = await supabaseClient
      .from("messages")
      .insert({
        conversation_id: state.activeConversationId,
        sender_id: state.currentUser.id,
        text,
        type: attachment?.type || "text",
        attachment_path: attachment?.path || null,
        attachment_name: attachment?.name || null,
        attachment_size: attachment?.size || null,
        attachment_mime: attachment?.mime || null
      })
      .select("id,conversation_id,sender_id,text,type,attachment_path,attachment_name,attachment_size,attachment_mime,metadata,recalled_at,created_at")
      .single();

    if (error) throw error;

    const members = await getConversationMembers(state.activeConversationId);
    const [message] = await hydrateMessages([data], members);
    appendMessage(message);
    elements.messageInput.value = "";
    clearAttachment();
    autosizeTextarea();
    renderMessages();
    await loadConversations();
  } catch (error) {
    elements.friendMessage.textContent = getFriendlyError(error);
  } finally {
    updateSendState();
  }
}

async function uploadAttachment(file) {
  if (file.size > 50 * 1024 * 1024) {
    throw new Error("附件最大支持 50MB。");
  }

  const safeName = sanitizeFileName(file.name);
  const path = `${state.currentUser.id}/${Date.now()}-${safeName}`;
  const { error } = await supabaseClient.storage
    .from("chat-attachments")
    .upload(path, file, {
      cacheControl: "3600",
      contentType: file.type || "application/octet-stream",
      upsert: false
    });

  if (error) throw error;

  return {
    path,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    type: getMessageTypeFromFile(file)
  };
}

function renderAttachmentPreview() {
  if (!state.attachmentFile) {
    elements.attachmentPreview.hidden = true;
    elements.attachmentPreview.textContent = "";
    return;
  }

  elements.attachmentPreview.hidden = false;
  elements.attachmentPreview.textContent = `已选择：${state.attachmentFile.name} · ${formatFileSize(state.attachmentFile.size)}`;
}

function clearAttachment() {
  state.attachmentFile = null;
  elements.attachmentInput.value = "";
  renderAttachmentPreview();
}

async function getConversationMembers(conversationId) {
  const { data, error } = await supabaseClient
    .from("conversation_members")
    .select("conversation_id,user_id,role,nickname,last_read_at,last_read_message_id,profiles(id,username,display_name,avatar,status,bio,gender,birthday,homepage,created_at)")
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

async function toggleConversationPin() {
  const conversation = getActiveConversation();
  if (!conversation) return;

  const { error } = await supabaseClient
    .from("conversation_members")
    .update({ pinned: !conversation.pinned })
    .eq("conversation_id", conversation.id)
    .eq("user_id", state.currentUser.id);

  if (error) throw error;
  conversation.pinned = !conversation.pinned;
  await loadConversations();
}

async function toggleConversationMute() {
  const conversation = getActiveConversation();
  if (!conversation) return;

  const mutedUntil = conversation.muted ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseClient
    .from("conversation_members")
    .update({ muted_until: mutedUntil })
    .eq("conversation_id", conversation.id)
    .eq("user_id", state.currentUser.id);

  if (error) throw error;
  conversation.mutedUntil = mutedUntil;
  conversation.muted = isMuted(mutedUntil);
  await loadConversations();
}

function renderActiveConversationControls() {
  const conversation = getActiveConversation();
  elements.pinConversationButton.disabled = !conversation;
  elements.muteConversationButton.disabled = !conversation;
  elements.pinConversationButton.classList.toggle("active", Boolean(conversation?.pinned));
  elements.muteConversationButton.classList.toggle("active", Boolean(conversation?.muted));
}

function subscribeRealtime() {
  unsubscribeRealtime();

  state.channel = supabaseClient
    .channel("codex-chat-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "message_actions" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members" }, refreshRealtimeData)
    .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, refreshRealtimeData)
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

function subscribeTyping(conversationId) {
  unsubscribeTyping();
  state.typingUsers.clear();
  renderTypingIndicator();

  state.typingChannel = supabaseClient
    .channel(`typing:${conversationId}`, {
      config: {
        broadcast: { self: false }
      }
    })
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!payload || payload.userId === state.currentUser.id) return;

      state.typingUsers.set(payload.userId, payload.name || "对方");
      clearTimeout(state.typingTimers.get(payload.userId));
      state.typingTimers.set(payload.userId, setTimeout(() => {
        state.typingUsers.delete(payload.userId);
        renderTypingIndicator();
      }, 2800));
      renderTypingIndicator();
    })
    .subscribe();
}

function unsubscribeTyping() {
  state.typingTimers.forEach((timer) => clearTimeout(timer));
  state.typingTimers.clear();
  state.typingUsers.clear();
  renderTypingIndicator();

  if (state.typingChannel) {
    supabaseClient.removeChannel(state.typingChannel);
    state.typingChannel = null;
  }
}

function announceTyping() {
  if (!state.typingChannel || !state.activeConversationId) return;

  const now = Date.now();
  if (now - state.lastTypingSentAt < 1400) return;
  state.lastTypingSentAt = now;

  state.typingChannel.send({
    type: "broadcast",
    event: "typing",
    payload: {
      userId: state.currentUser.id,
      name: state.currentUser.name
    }
  });
}

function renderTypingIndicator() {
  const names = [...state.typingUsers.values()];
  elements.typingIndicator.hidden = names.length === 0;
  elements.typingIndicator.textContent = names.length > 0 ? `${names.join("、")} 正在输入...` : "";
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

async function hydrateMessages(messages, members) {
  const serialized = messages.map((message) => serializeMessage(message, members, null));
  await attachSignedUrls(serialized);
  return serialized;
}

function serializeMessage(message, members, action) {
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
    type: message.type || "text",
    attachmentPath: message.attachment_path,
    attachmentName: message.attachment_name,
    attachmentSize: message.attachment_size,
    attachmentMime: message.attachment_mime,
    attachmentUrl: state.attachmentUrls.get(message.attachment_path) || "",
    recalled: Boolean(message.recalled_at),
    favorited: Boolean(action?.favorited),
    createdAt: message.created_at,
    readBy
  };
}

async function attachSignedUrls(messages) {
  const withAttachments = messages.filter((message) => message.attachmentPath);

  await Promise.all(withAttachments.map(async (message) => {
    if (state.attachmentUrls.has(message.attachmentPath)) {
      message.attachmentUrl = state.attachmentUrls.get(message.attachmentPath);
      return;
    }

    const { data, error } = await supabaseClient.storage
      .from("chat-attachments")
      .createSignedUrl(message.attachmentPath, 60 * 60);

    if (!error && data?.signedUrl) {
      state.attachmentUrls.set(message.attachmentPath, data.signedUrl);
      message.attachmentUrl = data.signedUrl;
    }
  }));
}

function serializeUser(profile) {
  if (!profile) {
    return {
      id: "",
      username: "unknown",
      name: "未知用户",
      avatar: "?",
      status: "offline"
    };
  }

  return {
    id: profile.id,
    username: profile.username,
    name: profile.display_name,
    avatar: profile.avatar,
    status: profile.status || "offline",
    bio: profile.bio || "",
    gender: profile.gender || "unspecified",
    birthday: profile.birthday || "",
    homepage: profile.homepage || "",
    createdAt: profile.created_at
  };
}

function getFilteredConversations() {
  const term = state.searchTerm;

  return state.conversations.filter((conversation) => {
    if (!term) return true;

    const haystack = [
      conversation.display.name,
      conversation.display.username,
      conversation.description,
      conversation.announcement,
      conversation.lastMessage?.text || ""
    ].join(" ").toLowerCase();
    const messageMatch = state.messageIndex.some((item) => item.conversationId === conversation.id && item.text.includes(term));

    return haystack.includes(term) || messageMatch;
  });
}

function matchUser(user, term) {
  if (!term) return true;
  return `${user.name} ${user.username} ${user.bio || ""}`.toLowerCase().includes(term);
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
  elements.sendButton.disabled = !state.activeConversationId
    || (elements.messageInput.value.trim().length === 0 && !state.attachmentFile);
}

function setConnectionState(stateName) {
  elements.connectionState.textContent = stateName === "online" ? "实时在线" : "离线";
  elements.connectionState.classList.toggle("online", stateName === "online");
}

function getActiveConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId) || null;
}

function isMuted(value) {
  return Boolean(value && new Date(value) > new Date());
}

function formatMessagePreview(message) {
  if (message.recalled) return "消息已撤回";
  if (message.type === "image") return `[图片] ${message.text || ""}`.trim();
  if (message.type === "video") return `[视频] ${message.text || ""}`.trim();
  if (message.type === "audio") return `[语音] ${message.text || ""}`.trim();
  if (message.type === "file") return `[文件] ${message.attachmentName || message.text || ""}`.trim();
  return message.text || "";
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
  return conversation.lastMessage?.createdAt || conversation.updatedAt || conversation.createdAt || new Date(0).toISOString();
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
    dnd: "勿扰",
    offline: "离线"
  };

  return labels[status] || "未知";
}

function createAvatar(displayName) {
  return Array.from(displayName || "CC").slice(0, 2).join("").toUpperCase();
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

function sanitizeFileName(value) {
  const name = String(value || "file").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
  return name.slice(-120);
}

function getMessageTypeFromFile(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

function formatFileSize(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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

  if (message.includes("storage")) {
    return "附件上传失败，请稍后再试。";
  }

  return message;
}
