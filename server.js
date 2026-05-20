import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { extname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = resolve(process.env.DATA_DIR || join(__dirname, "data"));
const outboxDir = join(dataDir, "outbox");
const dbPath = join(dataDir, "chat.sqlite");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const seedDemoUsers = process.env.SEED_DEMO_USERS === "true" || !isProduction;
const sessionDays = 30;
const emailVerificationHours = 24;

mkdirSync(dataDir, { recursive: true });
mkdirSync(outboxDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA journal_mode = WAL;");

const clients = new Map();

setupDatabase();
if (seedDemoUsers) {
  seedDatabase();
  backfillDemoEmailVerification();
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "服务器开小差了，请稍后再试。" });
  }
});

server.on("upgrade", handleUpgrade);

server.listen(port, () => {
  console.log(`Codex Chat is running at http://localhost:${port}`);
});

function setupDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      email_verified_at TEXT,
      display_name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      addressee_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (requester_id, addressee_id),
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'direct',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages (conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_friendships_addressee
      ON friendships (addressee_id, status);
  `);

  ensureColumn("users", "email", "TEXT");
  ensureColumn("users", "email_verified_at", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, consumed_at);");
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

function seedDatabase() {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (userCount > 0) return;

  const now = new Date().toISOString();
  const users = [
    { id: "u-me", username: "iwen", email: "iwen@example.com", displayName: "Iwen", avatar: "IW" },
    { id: "u-lina", username: "lina", email: "lina@example.com", displayName: "林娜", avatar: "LN" },
    { id: "u-chen", username: "chenyu", email: "chenyu@example.com", displayName: "陈屿", avatar: "CY" },
    { id: "u-ming", username: "minghe", email: "minghe@example.com", displayName: "明禾", avatar: "MH" }
  ];

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, email, email_verified_at, display_name, avatar, password_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?)
  `);

  users.forEach((user) => {
    insertUser.run(user.id, user.username, user.email, now, user.displayName, user.avatar, hashPassword("123456"), now);
  });

  [
    ["u-me", "u-lina"],
    ["u-me", "u-chen"],
    ["u-me", "u-ming"]
  ].forEach(([requesterId, addresseeId]) => {
    insertFriendship(requesterId, addresseeId, "accepted");
  });

  const product = ensureDirectConversation("u-me", "u-lina");
  const engineering = ensureDirectConversation("u-me", "u-chen");
  const design = ensureDirectConversation("u-me", "u-ming");

  db.prepare("UPDATE conversation_members SET pinned = 1 WHERE conversation_id = ? AND user_id = ?")
    .run(product, "u-me");

  seedMessage(product, "u-lina", "我们先把聊天首页做成可以演示的版本：联系人、会话、消息发送都能跑。", minutesAgo(33));
  seedMessage(product, "u-me", "赞，我会把前端和后端接口一起搭起来，后面可以接数据库和登录。", minutesAgo(29));
  seedMessage(product, "u-lina", "页面要干净一点，适合日常办公聊天，不要太像营销页。", minutesAgo(13));
  seedMessage(engineering, "u-chen", "后端先用内存数据就行，接口契约稳定后再换持久化。", hoursAgo(4));
  seedMessage(engineering, "u-me", "收到。我会让静态页面直接请求 /api/conversations 和 /api/messages。", hoursAgo(3));
  seedMessage(design, "u-ming", "消息气泡、输入栏和移动端布局都要先打磨一下。", yesterdayAt(18, 25));

  markConversationRead("u-me", engineering, false);
  markConversationRead("u-me", design, false);
  markConversationRead("u-lina", product, false);
  markConversationRead("u-chen", engineering, false);
  markConversationRead("u-ming", design, false);
}

function backfillDemoEmailVerification() {
  const now = new Date().toISOString();
  const demoEmails = [
    ["iwen", "iwen@example.com"],
    ["lina", "lina@example.com"],
    ["chenyu", "chenyu@example.com"],
    ["minghe", "minghe@example.com"]
  ];

  const update = db.prepare(`
    UPDATE users
    SET email = COALESCE(email, ?),
        email_verified_at = COALESCE(email_verified_at, ?)
    WHERE username = ?
  `);

  demoEmails.forEach(([username, email]) => {
    update.run(email, now, username);
  });
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    db.prepare("SELECT 1").get();
    sendJson(response, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      websocketClients: clients.size
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    await registerUser(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/verify-email") {
    verifyEmail(response, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/resend-verification") {
    await resendVerificationEmail(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    await loginUser(request, response);
    return;
  }

  const auth = authenticateRequest(request);

  if (!auth.user) {
    sendJson(response, 401, { error: "请先登录。" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(auth.tokenHash);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    sendJson(response, 200, { user: serializeUser(auth.user) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    const search = String(url.searchParams.get("search") || "");
    sendJson(response, 200, { users: searchUsers(auth.user.id, search) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/friends") {
    sendJson(response, 200, getFriendsPayload(auth.user.id));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/friends/request") {
    await requestFriend(request, response, auth.user.id);
    return;
  }

  const acceptFriendMatch = url.pathname.match(/^\/api\/friends\/([^/]+)\/accept$/);
  if (request.method === "POST" && acceptFriendMatch) {
    acceptFriendRequest(response, auth.user.id, acceptFriendMatch[1]);
    return;
  }

  const deleteFriendMatch = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
  if (request.method === "DELETE" && deleteFriendMatch) {
    deleteFriendship(response, auth.user.id, deleteFriendMatch[1]);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    sendJson(response, 200, {
      currentUser: serializeUser(auth.user),
      conversations: listConversationSummaries(auth.user.id)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/conversations/direct") {
    await openDirectConversation(request, response, auth.user.id);
    return;
  }

  const messagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && request.method === "GET") {
    const conversationId = messagesMatch[1];

    if (!isConversationMember(conversationId, auth.user.id)) {
      sendJson(response, 404, { error: "没有找到这个会话。" });
      return;
    }

    sendJson(response, 200, {
      conversation: getConversationSummary(conversationId, auth.user.id),
      messages: listMessages(conversationId, auth.user.id)
    });
    return;
  }

  if (messagesMatch && request.method === "POST") {
    await createConversationMessage(request, response, auth.user.id, messagesMatch[1]);
    return;
  }

  const readMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
  if (readMatch && request.method === "POST") {
    const conversationId = readMatch[1];

    if (!isConversationMember(conversationId, auth.user.id)) {
      sendJson(response, 404, { error: "没有找到这个会话。" });
      return;
    }

    const readAt = markConversationRead(auth.user.id, conversationId);
    const payload = {
      type: "conversation:read",
      conversationId,
      user: serializeUser(getUserById(auth.user.id)),
      readAt,
      conversation: getConversationSummary(conversationId, auth.user.id)
    };

    broadcastToConversation(conversationId, payload);
    sendJson(response, 200, {
      readAt,
      conversation: getConversationSummary(conversationId, auth.user.id)
    });
    return;
  }

  sendJson(response, 404, { error: "接口不存在。" });
}

async function registerUser(request, response) {
  const body = await readJsonBody(request);
  const username = normalizeUsername(body.username);
  const email = normalizeEmail(body.email);
  const displayName = String(body.displayName || body.username || "").trim();
  const password = String(body.password || "");

  if (!username || username.length < 3) {
    sendJson(response, 400, { error: "用户名至少需要 3 个字符。" });
    return;
  }

  if (!isValidEmail(email)) {
    sendJson(response, 400, { error: "请填写有效的邮箱地址。" });
    return;
  }

  if (!displayName) {
    sendJson(response, 400, { error: "请填写昵称。" });
    return;
  }

  if (password.length < 6) {
    sendJson(response, 400, { error: "密码至少需要 6 位。" });
    return;
  }

  if (getUserByUsername(username)) {
    sendJson(response, 409, { error: "这个用户名已经被使用。" });
    return;
  }

  if (getUserByEmail(email)) {
    sendJson(response, 409, { error: "这个邮箱已经被注册。" });
    return;
  }

  const user = {
    id: id("u"),
    username,
    email,
    displayName,
    avatar: createAvatar(displayName)
  };

  db.prepare(`
    INSERT INTO users (id, username, email, email_verified_at, display_name, avatar, password_hash, status, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 'offline', ?)
  `).run(user.id, user.username, user.email, user.displayName, user.avatar, hashPassword(password), new Date().toISOString());

  const verification = createEmailVerification(user.id, user.email, getBaseUrl(request));
  await sendVerificationEmail({
    to: user.email,
    displayName: user.displayName,
    verificationUrl: verification.url
  });

  sendJson(response, 201, {
    requiresVerification: true,
    email: user.email,
    message: "注册成功，请到邮箱中点击确认链接后再登录。",
    devOutboxPath: smtpConfigured() ? undefined : outboxDir
  });
}

async function loginUser(request, response) {
  const body = await readJsonBody(request);
  const login = normalizeEmail(body.email || body.username);
  const password = String(body.password || "");
  const user = login.includes("@") ? getUserByEmail(login) : getUserByUsername(normalizeUsername(login));

  if (!user || !verifyPassword(password, user.password_hash)) {
    sendJson(response, 401, { error: "用户名或密码不正确。" });
    return;
  }

  if (!user.email_verified_at) {
    sendJson(response, 403, {
      error: "请先到邮箱中点击确认链接，再登录账号。",
      requiresVerification: true,
      email: user.email
    });
    return;
  }

  const token = issueSession(user.id);
  sendJson(response, 200, { token, user: serializeUser(user) });
}

async function resendVerificationEmail(request, response) {
  const body = await readJsonBody(request);
  const login = normalizeEmail(body.email || body.username);
  const user = login.includes("@") ? getUserByEmail(login) : getUserByUsername(normalizeUsername(login));

  if (!user) {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (user.email_verified_at) {
    sendJson(response, 200, { ok: true, alreadyVerified: true });
    return;
  }

  const verification = createEmailVerification(user.id, user.email, getBaseUrl(request));
  await sendVerificationEmail({
    to: user.email,
    displayName: user.display_name,
    verificationUrl: verification.url
  });

  sendJson(response, 200, {
    ok: true,
    requiresVerification: true,
    email: user.email,
    devOutboxPath: smtpConfigured() ? undefined : outboxDir
  });
}

function verifyEmail(response, url) {
  const token = String(url.searchParams.get("token") || "").trim();

  if (!token) {
    sendVerificationPage(response, 400, "确认链接无效", "邮件确认链接缺少必要参数。");
    return;
  }

  const tokenHash = hashToken(token);
  const verification = db.prepare(`
    SELECT * FROM email_verifications
    WHERE token_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `).get(tokenHash, new Date().toISOString());

  if (!verification) {
    sendVerificationPage(response, 400, "确认链接已失效", "请回到注册页面重新发送确认邮件。");
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users
    SET email = ?, email_verified_at = ?
    WHERE id = ?
  `).run(verification.email, now, verification.user_id);

  db.prepare(`
    UPDATE email_verifications
    SET consumed_at = ?
    WHERE token_hash = ?
  `).run(now, tokenHash);

  sendVerificationPage(response, 200, "邮箱确认成功", "现在可以回到 Codex Chat 登录账号了。");
}

async function requestFriend(request, response, userId) {
  const body = await readJsonBody(request);
  const username = normalizeUsername(body.username);
  const targetId = String(body.userId || "").trim();
  const target = targetId ? getUserById(targetId) : getUserByUsername(username);

  if (!target || target.id === userId) {
    sendJson(response, 404, { error: "没有找到这个用户。" });
    return;
  }

  const existing = getFriendship(userId, target.id);
  if (existing?.status === "accepted") {
    sendJson(response, 409, { error: "你们已经是好友。" });
    return;
  }

  if (existing?.status === "pending" && existing.addressee_id === userId) {
    const conversationId = acceptFriendship(existing.id, existing.requester_id, userId);
    notifyFriendAccepted(userId, existing.requester_id, conversationId);
    sendJson(response, 200, getFriendsPayload(userId));
    return;
  }

  if (existing?.status === "pending") {
    sendJson(response, 409, { error: "好友请求已经发送。" });
    return;
  }

  insertFriendship(userId, target.id, "pending");
  sendToUser(target.id, {
    type: "friend:request",
    from: serializeUser(getUserById(userId))
  });
  sendJson(response, 201, getFriendsPayload(userId));
}

function acceptFriendRequest(response, userId, requesterId) {
  const friendship = db.prepare(`
    SELECT * FROM friendships
    WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'
  `).get(requesterId, userId);

  if (!friendship) {
    sendJson(response, 404, { error: "没有找到这个好友请求。" });
    return;
  }

  const conversationId = acceptFriendship(friendship.id, requesterId, userId);
  notifyFriendAccepted(userId, requesterId, conversationId);
  sendJson(response, 200, getFriendsPayload(userId));
}

function deleteFriendship(response, userId, otherUserId) {
  db.prepare(`
    DELETE FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?)
       OR (requester_id = ? AND addressee_id = ?)
  `).run(userId, otherUserId, otherUserId, userId);

  sendJson(response, 200, getFriendsPayload(userId));
}

async function openDirectConversation(request, response, userId) {
  const body = await readJsonBody(request);
  const otherUserId = String(body.userId || "").trim();
  const relationship = getFriendship(userId, otherUserId);

  if (!relationship || relationship.status !== "accepted") {
    sendJson(response, 403, { error: "添加好友后才能开始聊天。" });
    return;
  }

  const conversationId = ensureDirectConversation(userId, otherUserId);
  sendJson(response, 200, {
    conversation: getConversationSummary(conversationId, userId)
  });
}

async function createConversationMessage(request, response, userId, conversationId) {
  if (!isConversationMember(conversationId, userId)) {
    sendJson(response, 404, { error: "没有找到这个会话。" });
    return;
  }

  const body = await readJsonBody(request);
  const text = String(body.text || "").trim();

  if (!text) {
    sendJson(response, 400, { error: "消息内容不能为空。" });
    return;
  }

  const message = insertMessage(conversationId, userId, text);
  const members = getConversationMembers(conversationId);

  members.forEach((member) => {
    sendToUser(member.id, {
      type: "message:new",
      conversationId,
      message: serializeMessage(message, member.id),
      conversation: getConversationSummary(conversationId, member.id)
    });
  });

  sendJson(response, 201, {
    message: serializeMessage(message, userId),
    conversation: getConversationSummary(conversationId, userId)
  });
}

function createEmailVerification(userId, email, baseUrl) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + emailVerificationHours * 60 * 60 * 1000);
  const token = randomBytes(32).toString("base64url");

  db.prepare(`
    UPDATE email_verifications
    SET consumed_at = ?
    WHERE user_id = ? AND consumed_at IS NULL
  `).run(now.toISOString(), userId);

  db.prepare(`
    INSERT INTO email_verifications (token_hash, user_id, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, email, now.toISOString(), expiresAt.toISOString());

  return {
    token,
    url: `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`
  };
}

async function sendVerificationEmail({ to, displayName, verificationUrl }) {
  const subject = "确认你的 Codex Chat 邮箱";
  const text = [
    `${displayName}，你好：`,
    "",
    "请打开下面的链接确认邮箱，确认后就可以登录 Codex Chat。",
    verificationUrl,
    "",
    `这个链接将在 ${emailVerificationHours} 小时后失效。`
  ].join("\n");
  const html = `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.6;color:#1f2a26">
      <h2>确认你的 Codex Chat 邮箱</h2>
      <p>${escapeHtml(displayName)}，你好：</p>
      <p>请点击下面的按钮完成邮箱确认，确认后就可以登录 Codex Chat。</p>
      <p><a href="${escapeHtml(verificationUrl)}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px">确认邮箱</a></p>
      <p>如果按钮无法打开，请复制这个链接到浏览器：</p>
      <p><a href="${escapeHtml(verificationUrl)}">${escapeHtml(verificationUrl)}</a></p>
      <p style="color:#65736d;font-size:13px">这个链接将在 ${emailVerificationHours} 小时后失效。</p>
    </div>
  `;

  if (smtpConfigured()) {
    await sendSmtpMail({ to, subject, text, html });
    return;
  }

  const filename = `${Date.now()}-${to.replace(/[^a-z0-9._-]/gi, "_")}.html`;
  await writeFile(join(outboxDir, filename), html, "utf8");
  console.log(`Email verification written to ${join(outboxDir, filename)}`);
  console.log(`Verification URL: ${verificationUrl}`);
}

async function sendSmtpMail({ to, subject, text, html }) {
  const config = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587)),
    secure: process.env.SMTP_SECURE === "true",
    startTls: process.env.SMTP_STARTTLS !== "false",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@codex-chat.local"
  };

  let socket = await openSmtpSocket(config);
  let client = createSmtpClient(socket);

  await client.read(220);
  await client.command("EHLO codex-chat.local", 250);

  if (!config.secure && config.startTls) {
    await client.command("STARTTLS", 220);
    socket = tls.connect({ socket, servername: config.host });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    client = createSmtpClient(socket);
    await client.command("EHLO codex-chat.local", 250);
  }

  if (config.user) {
    const auth = Buffer.from(`\0${config.user}\0${config.pass}`).toString("base64");
    await client.command(`AUTH PLAIN ${auth}`, 235);
  }

  await client.command(`MAIL FROM:<${extractEmail(config.from)}>`, 250);
  await client.command(`RCPT TO:<${to}>`, [250, 251]);
  await client.command("DATA", 354);
  socket.write(`${buildEmailMessage({ from: config.from, to, subject, text, html })}\r\n.\r\n`);
  await client.read(250);
  await client.command("QUIT", 221);
  socket.end();
}

function openSmtpSocket(config) {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });

    socket.once(config.secure ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createSmtpClient(socket) {
  let buffer = "";
  const waiters = [];

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });

  socket.on("error", (error) => {
    while (waiters.length) {
      waiters.shift().reject(error);
    }
  });

  function flush() {
    const response = extractSmtpResponse();
    if (!response || waiters.length === 0) return;
    waiters.shift().resolve(response);
  }

  function extractSmtpResponse() {
    const lines = buffer.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      if (/^\d{3} /.test(lines[index])) {
        const responseLines = lines.slice(0, index + 1);
        buffer = lines.slice(index + 1).join("\r\n");
        return {
          code: Number(lines[index].slice(0, 3)),
          message: responseLines.join("\n")
        };
      }
    }

    return null;
  }

  async function read(expectedCodes) {
    const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    const response = await new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      flush();
    });

    if (!codes.includes(response.code)) {
      throw new Error(`SMTP error ${response.code}: ${response.message}`);
    }

    return response;
  }

  async function command(line, expectedCodes) {
    socket.write(`${line}\r\n`);
    return read(expectedCodes);
  }

  return { read, command };
}

function buildEmailMessage({ from, to, subject, text, html }) {
  const boundary = `codex-chat-${randomBytes(8).toString("hex")}`;
  const safeText = dotStuff(text);
  const safeHtml = dotStuff(html);

  return [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    safeText,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    safeHtml,
    `--${boundary}--`
  ].join("\r\n");
}

function sendVerificationPage(response, statusCode, title, message) {
  sendHtml(response, statusCode, `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
        <style>
          body{margin:0;min-height:100vh;display:grid;place-items:center;background:#edf2f0;color:#1f2a26;font-family:Inter,system-ui,"Microsoft YaHei",sans-serif}
          main{width:min(420px,calc(100vw - 32px));padding:24px;background:#fff;border:1px solid #d9e2de;border-radius:8px;box-shadow:0 18px 54px rgba(30,42,38,.13)}
          h1{margin:0 0 10px;font-size:22px}p{margin:0 0 18px;color:#65736d;line-height:1.6}a{display:inline-grid;height:40px;place-items:center;padding:0 16px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none;font-weight:800}
        </style>
      </head>
      <body>
        <main>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(message)}</p>
          <a href="/">返回登录</a>
        </main>
      </body>
    </html>`);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function getBaseUrl(request) {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }

  const protocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return `${protocol}://${host}`;
}

async function serveStatic(pathname, response) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    const type = mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    response.end(file);
  } catch {
    const file = await readFile(join(publicDir, "index.html"));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(file);
  }
}

function getFriendsPayload(userId) {
  const accepted = db.prepare(`
    SELECT u.*
    FROM friendships f
    JOIN users u ON u.id = CASE
      WHEN f.requester_id = ? THEN f.addressee_id
      ELSE f.requester_id
    END
    WHERE (f.requester_id = ? OR f.addressee_id = ?)
      AND f.status = 'accepted'
    ORDER BY u.display_name
  `).all(userId, userId, userId);

  const incoming = db.prepare(`
    SELECT u.*, f.created_at AS requested_at
    FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(userId);

  const outgoing = db.prepare(`
    SELECT u.*, f.created_at AS requested_at
    FROM friendships f
    JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(userId);

  return {
    friends: accepted.map((user) => ({
      ...serializeUser(user),
      conversationId: ensureDirectConversation(userId, user.id)
    })),
    incoming: incoming.map(serializeUser),
    outgoing: outgoing.map(serializeUser)
  };
}

function searchUsers(userId, search) {
  const term = `%${String(search || "").trim().toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM users
    WHERE id != ?
      AND (? = '%%' OR username LIKE ? OR lower(display_name) LIKE ?)
    ORDER BY display_name
    LIMIT 12
  `).all(userId, term, term, term).map((user) => {
    const relationship = getFriendship(userId, user.id);
    return {
      ...serializeUser(user),
      relationship: relationship?.status || "none",
      direction: relationship ? (relationship.requester_id === userId ? "outgoing" : "incoming") : "none"
    };
  });
}

function listConversationSummaries(userId) {
  const rows = db.prepare(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    LEFT JOIN messages lm ON lm.id = (
      SELECT id FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    )
    WHERE cm.user_id = ?
    ORDER BY cm.pinned DESC, COALESCE(lm.created_at, c.created_at) DESC
  `).all(userId);

  return rows.map((row) => getConversationSummary(row.id, userId)).filter(Boolean);
}

function getConversationSummary(conversationId, userId) {
  const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  if (!conversation || !isConversationMember(conversationId, userId)) return null;

  const members = getConversationMembers(conversationId);
  const contact = members.find((member) => member.id !== userId) || members[0];
  const lastMessage = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId);

  const memberState = db.prepare(`
    SELECT * FROM conversation_members
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId);

  const unread = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE conversation_id = ?
      AND sender_id != ?
      AND created_at > COALESCE(?, '')
  `).get(conversationId, userId, memberState?.last_read_at || "").count;

  return {
    id: conversation.id,
    type: conversation.type,
    contact: serializeUser(contact),
    unread,
    pinned: Boolean(memberState?.pinned),
    lastMessage: lastMessage ? serializeMessage(lastMessage, userId) : null,
    createdAt: conversation.created_at
  };
}

function listMessages(conversationId, viewerId) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId).map((message) => serializeMessage(message, viewerId));
}

function serializeMessage(message, viewerId) {
  const sender = getUserById(message.sender_id);
  const readBy = db.prepare(`
    SELECT u.*
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
      AND cm.user_id != ?
      AND cm.last_read_at IS NOT NULL
      AND cm.last_read_at >= ?
  `).all(message.conversation_id, message.sender_id, message.created_at);

  return {
    id: message.id,
    conversationId: message.conversation_id,
    senderId: message.sender_id,
    sender: serializeUser(sender),
    text: message.text,
    createdAt: message.created_at,
    readBy: readBy.filter((user) => user.id !== viewerId).map(serializeUser)
  };
}

function markConversationRead(userId, conversationId, updateLastMessage = true) {
  const lastMessage = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId);

  const readAt = updateLastMessage ? new Date().toISOString() : lastMessage?.created_at || new Date().toISOString();
  db.prepare(`
    UPDATE conversation_members
    SET last_read_message_id = ?, last_read_at = ?
    WHERE conversation_id = ? AND user_id = ?
  `).run(lastMessage?.id || null, readAt, conversationId, userId);

  return readAt;
}

function insertMessage(conversationId, senderId, text, createdAt = new Date().toISOString()) {
  const message = {
    id: id("m"),
    conversation_id: conversationId,
    sender_id: senderId,
    text,
    created_at: createdAt
  };

  db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(message.id, message.conversation_id, message.sender_id, message.text, message.created_at);

  db.prepare(`
    UPDATE conversation_members
    SET last_read_message_id = ?, last_read_at = ?
    WHERE conversation_id = ? AND user_id = ?
  `).run(message.id, message.created_at, conversationId, senderId);

  return message;
}

function seedMessage(conversationId, senderId, text, createdAt) {
  insertMessage(conversationId, senderId, text, createdAt);
}

function ensureDirectConversation(userA, userB) {
  const existing = db.prepare(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
    JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
    WHERE c.type = 'direct'
    LIMIT 1
  `).get(userA, userB);

  if (existing) return existing.id;

  const conversationId = id("c");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO conversations (id, type, created_at) VALUES (?, 'direct', ?)")
    .run(conversationId, now);

  const insertMember = db.prepare(`
    INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
    VALUES (?, ?, ?)
  `);
  insertMember.run(conversationId, userA, now);
  insertMember.run(conversationId, userB, now);

  return conversationId;
}

function getConversationMembers(conversationId) {
  return db.prepare(`
    SELECT u.*
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
  `).all(conversationId);
}

function isConversationMember(conversationId, userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM conversation_members
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId));
}

function insertFriendship(requesterId, addresseeId, status) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id("f"), requesterId, addresseeId, status, now, now);
}

function acceptFriendship(friendshipId, requesterId, addresseeId) {
  db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), friendshipId);
  return ensureDirectConversation(requesterId, addresseeId);
}

function notifyFriendAccepted(userId, otherUserId, conversationId) {
  const users = [userId, otherUserId];

  users.forEach((recipientId) => {
    const friendId = recipientId === userId ? otherUserId : userId;
    sendToUser(recipientId, {
      type: "friend:accepted",
      friend: {
        ...serializeUser(getUserById(friendId)),
        conversationId
      },
      conversation: getConversationSummary(conversationId, recipientId)
    });
  });
}

function getFriendship(userA, userB) {
  return db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?)
       OR (requester_id = ? AND addressee_id = ?)
    LIMIT 1
  `).get(userA, userB, userB, userA);
}

function getUserById(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function serializeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: Boolean(user.email_verified_at),
    name: user.display_name,
    avatar: user.avatar,
    status: clients.has(user.id) ? "online" : user.status,
    createdAt: user.created_at
  };
}

function authenticateRequest(request) {
  const authHeader = request.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { user: null };

  const token = match[1].trim();
  const tokenHash = hashToken(token);
  const session = db.prepare(`
    SELECT * FROM sessions
    WHERE token_hash = ? AND expires_at > ?
  `).get(tokenHash, new Date().toISOString());

  if (!session) return { user: null };

  const user = getUserById(session.user_id);
  if (!user?.email_verified_at) {
    return { user: null };
  }

  return { user, tokenHash };
}

function issueSession(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ? OR expires_at <= ?")
    .run(userId, new Date().toISOString());

  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionDays * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashToken(token), userId, createdAt.toISOString(), expiresAt.toISOString());

  return token;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;

  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createAvatar(displayName) {
  return Array.from(displayName).slice(0, 2).join("").toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function encodeMimeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), "utf8").toString("base64")}?=`;
}

function formatAddress(value) {
  const email = extractEmail(value);
  const name = String(value).replace(/<[^>]+>/, "").trim();

  if (!name || name === email) {
    return `<${email}>`;
  }

  return `${encodeMimeHeader(name)} <${email}>`;
}

function extractEmail(value) {
  const match = String(value).match(/<([^>]+)>/);
  return (match ? match[1] : String(value)).trim();
}

function dotStuff(value) {
  return String(value).replace(/\r?\n\./g, "\r\n..");
}

function handleUpgrade(request, socket) {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token") || "";
    const session = db.prepare(`
      SELECT * FROM sessions
      WHERE token_hash = ? AND expires_at > ?
    `).get(hashToken(token), new Date().toISOString());

    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));

    socket.userId = session.user_id;
    socket.wsBuffer = Buffer.alloc(0);
    socket.chatClosed = false;

    addClient(socket.userId, socket);
    updateUserStatus(socket.userId, "online");
    broadcastPresence(socket.userId, "online");
    sendWs(socket, { type: "socket:ready", user: serializeUser(getUserById(socket.userId)) });

    socket.on("data", (chunk) => handleWsData(socket, chunk));
    socket.on("close", () => removeClient(socket));
    socket.on("end", () => removeClient(socket));
    socket.on("error", () => removeClient(socket));
  } catch (error) {
    console.error(error);
    socket.destroy();
  }
}

function addClient(userId, socket) {
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }
  clients.get(userId).add(socket);
}

function removeClient(socket) {
  if (socket.chatClosed) return;
  socket.chatClosed = true;

  const sockets = clients.get(socket.userId);
  if (!sockets) return;

  sockets.delete(socket);
  if (sockets.size === 0) {
    clients.delete(socket.userId);
    updateUserStatus(socket.userId, "offline");
    broadcastPresence(socket.userId, "offline");
  }
}

function handleWsData(socket, chunk) {
  socket.wsBuffer = Buffer.concat([socket.wsBuffer, chunk]);

  while (socket.wsBuffer.length > 0) {
    const frame = readWsFrame(socket.wsBuffer);
    if (!frame) return;

    socket.wsBuffer = frame.remaining;

    if (frame.opcode === 0x8) {
      socket.end();
      return;
    }

    if (frame.opcode === 0x9) {
      socket.write(encodeWsFrame(frame.payload, 0xA));
      continue;
    }

    if (frame.opcode !== 0x1) continue;

    try {
      const message = JSON.parse(frame.payload.toString("utf8"));
      handleWsMessage(socket, message);
    } catch {
      sendWs(socket, { type: "error", error: "WebSocket 消息格式不正确。" });
    }
  }
}

function handleWsMessage(socket, message) {
  if (message.type === "ping") {
    sendWs(socket, { type: "pong", at: new Date().toISOString() });
  }
}

function readWsFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;

  let mask;
  if (masked) {
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    remaining: buffer.subarray(offset + length)
  };
}

function encodeWsFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function sendWs(socket, payload) {
  if (socket.destroyed) return;
  socket.write(encodeWsFrame(JSON.stringify(payload)));
}

function sendToUser(userId, payload) {
  const sockets = clients.get(userId);
  if (!sockets) return;

  sockets.forEach((socket) => sendWs(socket, payload));
}

function broadcastToConversation(conversationId, payload) {
  getConversationMembers(conversationId).forEach((member) => sendToUser(member.id, payload));
}

function broadcastPresence(userId, status) {
  const friendRows = db.prepare(`
    SELECT CASE
      WHEN requester_id = ? THEN addressee_id
      ELSE requester_id
    END AS friend_id
    FROM friendships
    WHERE (requester_id = ? OR addressee_id = ?)
      AND status = 'accepted'
  `).all(userId, userId, userId);

  const user = serializeUser(getUserById(userId));
  const payload = { type: "presence:update", user: { ...user, status } };

  friendRows.forEach((row) => sendToUser(row.friend_id, payload));
  sendToUser(userId, payload);
}

function updateUserStatus(userId, status) {
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function id(prefix) {
  return `${prefix}-${randomBytes(9).toString("hex")}`;
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function yesterdayAt(hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}
