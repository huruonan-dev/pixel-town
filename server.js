import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 用户数据持久化 ──
const USERS_FILE = path.join(__dirname, 'users.json');
function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.post('/api/checkin', (req, res) => {
  const { name, dept, birthday } = req.body;
  if (!name) return res.json({ ok: false });
  const users = readUsers();
  const idx = users.findIndex(u => u.name === name);
  const isNew = idx === -1;
  const user = { name, dept: dept || '', birthday: birthday || '' };
  if (idx !== -1) users[idx] = user; else users.push(user);
  saveUsers(users);
  res.json({ ok: true, isNew });
});

// ── 金币排行榜 ──
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
function readLeaderboard() {
  try { return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8')); }
  catch { return { weekStart: '', scores: {} }; }
}
function saveLeaderboard(data) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2));
}
function getMondayStr() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d); mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}
function getLeaderboard() {
  const lb = readLeaderboard();
  const thisMonday = getMondayStr();
  if (lb.weekStart !== thisMonday) {
    lb.weekStart = thisMonday;
    lb.scores = {};
    saveLeaderboard(lb);
  }
  return lb;
}

app.get('/api/leaderboard', (req, res) => {
  const lb = getLeaderboard();
  const list = Object.entries(lb.scores)
    .map(([name, d]) => ({ name, dept: d.dept || '', money: d.money || 0 }))
    .sort((a, b) => b.money - a.money)
    .slice(0, 20);
  res.json({ weekStart: lb.weekStart, list });
});

app.post('/api/update-money', (req, res) => {
  const { name, dept, money } = req.body;
  if (!name || money == null) return res.json({ ok: false });
  const lb = getLeaderboard();
  lb.scores[name] = { dept: dept || '', money: Number(money) };
  saveLeaderboard(lb);
  res.json({ ok: true });
});

app.get('/api/today-birthdays', (req, res) => {
  const d = new Date();
  const today = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const users = readUsers();
  const birthdays = users.filter(u => u.birthday === today).map(u => u.name);
  res.json({ birthdays });
});

// ── 普通偶遇事件（双版本）──
app.post('/api/event', async (req, res) => {
  const { charA, charB, location } = req.body;
  try {
    const message = await client.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 250,
      messages: [
        { role: 'system', content: `你是像素小镇的事件记录员。为两人偶遇生成两个版本的记录，只返回JSON，不含其他文字：
{
  "short": "不超过18字的简洁记录，例如'A与B在地点相遇，聊了几句'",
  "detail": "25到50字的有趣第三人称故事，带一个小细节或反转，模仿'长公主日常'轻松风格，不用markdown格式"
}` },
        { role: 'user', content: `地点：${location}
甲：${charA.name}（${charA.dept}），性格${charA.personality}，爱好${charA.interests}
乙：${charB.name}（${charB.dept}），性格${charB.personality}，爱好${charB.interests}` }
      ]
    });
    const raw = message.choices[0].message.content.trim();
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    res.json({
      short:  (obj.short  || '').slice(0, 25),
      detail: (obj.detail || obj.short || '').slice(0, 120),
    });
  } catch (error) {
    console.error('事件API错误:', error.message);
    res.status(500).json({ error: '事件生成失败' });
  }
});

// ── 奇遇事件 ──
app.post('/api/adventure', async (req, res) => {
  const { name, dept, interests, location, theme, mood, money } = req.body;
  try {
    const message = await client.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 200,
      messages: [
        { role: 'system', content: `你是像素小镇的奇遇记录员。根据玩家当前状态和地点，生成一个有趣的随机奇遇事件，只返回JSON：
{
  "icon": "一个相关emoji",
  "title": "奇遇标题（5字以内）",
  "text": "25-50字的第三人称奇遇故事，有趣生动，带意外感",
  "moodDelta": 心情变化数值（-20到+20的整数），
  "moneyDelta": 金钱变化数值（-50到+100的整数）
}
心情和金钱变化要与故事内容一致。` },
        { role: 'user', content: `玩家：${name}（${dept}），爱好：${interests}
当前地点：${location}（${theme}场景）
当前心情：${mood}/100，金钱：¥${money}` }
      ]
    });
    const raw = message.choices[0].message.content.trim();
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    res.json(obj);
  } catch(e) {
    console.error('奇遇API错误:', e.message);
    res.status(500).json({ error: '奇遇生成失败' });
  }
});

// ── 特殊任务 ──
app.post('/api/special-task', async (req, res) => {
  const { nameA, nameB } = req.body;
  try {
    const message = await client.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5',
      max_tokens: 120,
      messages: [
        { role: 'system', content: `你是公司轻松团建活动策划师。为两位同事设计一个极简单的友好互动小任务。
严格要求：
- 不超过25字
- I人友好，5秒可完成，低门槛
- 绝对不能有任何暧昧、感情成分，只是普通同事日常互动
- 具体可执行，例如：互道早安、互相说今天最想吃什么、各说一个今日心情词
只返回JSON：{"task": "任务内容"}` },
        { role: 'user', content: `今日初次相遇的两位同事：${nameA} 和 ${nameB}` }
      ]
    });
    const raw = message.choices[0].message.content.trim();
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    res.json({ task: obj.task || `向 ${nameB} 说一句今日问候吧！` });
  } catch(e) {
    console.error('特殊任务错误:', e.message);
    res.json({ task: `和 ${nameB} 互相说一个今天的心情词吧！` });
  }
});

// ── Socket.io 实时多人 ──
const onlinePlayers = new Map();

// ── 心愿条（全局，持久化）──
const WISHES_FILE = path.join(__dirname, 'wishes.json');
function loadWishes() {
  try { return JSON.parse(fs.readFileSync(WISHES_FILE, 'utf8')); }
  catch { return []; }
}
function saveWishes() {
  fs.writeFileSync(WISHES_FILE, JSON.stringify(wishes, null, 2));
}
let wishes = loadWishes();

// ── 便利贴（按场所存储，持久化）──
const STICKY_FILE = path.join(__dirname, 'stickynotes.json');
function loadStickyNotes() {
  try { return JSON.parse(fs.readFileSync(STICKY_FILE, 'utf8')); }
  catch { return {}; }
}
function saveStickyNotes() {
  fs.writeFileSync(STICKY_FILE, JSON.stringify(stickyNotes, null, 2));
}
const stickyNotes = loadStickyNotes();

// ── 玩家发言 ──

io.on('connection', (socket) => {
  socket.emit('players:all', [...onlinePlayers.values()]);

  socket.on('player:join', (data) => {
    const player = {
      id: socket.id,
      name: data.name, dept: data.dept,
      color: data.color,
      pixelAttrs: data.pixelAttrs,
      x: data.x, y: data.y,
      state: 'idle',
      specialEnabled: !!data.specialEnabled,
      interaction: null,
    };
    onlinePlayers.set(socket.id, player);
    socket.broadcast.emit('player:join', player);
    console.log(`✦ ${data.name}（${data.dept}）进入小镇`);
  });

  socket.on('player:move', ({ x, y, state }) => {
    const p = onlinePlayers.get(socket.id);
    if (p) {
      p.x = x; p.y = y; p.state = state;
      socket.broadcast.emit('player:move', { id: socket.id, x, y, state });
    }
  });

  // 互动场景状态广播
  socket.on('player:interaction', ({ id }) => {
    const p = onlinePlayers.get(socket.id);
    if (p) {
      p.interaction = id || null;
      socket.broadcast.emit('player:interaction', { id: socket.id, interaction: id || null });
    }
  });

  // 特殊任务开关更新
  socket.on('player:special-toggle', ({ enabled }) => {
    const p = onlinePlayers.get(socket.id);
    if (p) {
      p.specialEnabled = !!enabled;
      socket.broadcast.emit('player:special-update', { id: socket.id, specialEnabled: !!enabled });
    }
  });

  // 广播事件（公共 + 私密）
  socket.on('event:broadcast', (data) => {
    io.emit('event:receive', data);
  });

  // 广播特殊任务（只给相关双方过滤，但全员收到让前端过滤）
  socket.on('event:special-broadcast', (data) => {
    io.emit('event:special-receive', data);
  });

  // 新居民首次入镇广播
  socket.on('player:new-arrival', ({ name, dept }) => {
    io.emit('new:arrival', { name, dept });
  });

  // 玩家发言气泡
  socket.on('player:say', ({ text }) => {
    const p = onlinePlayers.get(socket.id);
    if (!p) return;
    const safe = String(text || '').slice(0, 30).trim();
    if (!safe) return;
    io.emit('player:say', { id: socket.id, name: p.name, text: safe });
  });

  // 便利贴：获取
  socket.on('sticky:get', ({ venue }) => {
    socket.emit('sticky:update', { venue, notes: stickyNotes[venue] || [] });
  });

  // 便利贴：发布
  socket.on('sticky:post', ({ venue, author, text }) => {
    if (!venue || !author || !text) return;
    if (!stickyNotes[venue]) stickyNotes[venue] = [];
    if (stickyNotes[venue].length >= 30) stickyNotes[venue].shift();
    const note = { id: Date.now() + '_' + Math.random().toString(36).slice(2), author, text: String(text).slice(0,50), timestamp: Date.now(), replies: [] };
    stickyNotes[venue].push(note);
    saveStickyNotes();
    io.emit('sticky:update', { venue, notes: stickyNotes[venue] });
  });

  // 便利贴：回复
  socket.on('sticky:reply', ({ venue, noteId, author, text }) => {
    const notes = stickyNotes[venue] || [];
    const note = notes.find(n => n.id === noteId);
    if (!note) return;
    if (note.replies.length >= 10) note.replies.shift();
    note.replies.push({ author, text: String(text).slice(0,40), timestamp: Date.now() });
    saveStickyNotes();
    io.emit('sticky:update', { venue, notes });
  });

  // 心愿条：获取
  socket.on('wish:get', ({ name }) => {
    socket.emit('wish:all', wishes.map(w => ({
      ...w,
      hidden: w.hidden && w.author !== name ? undefined : w.hidden
    })));
  });

  // 心愿条：发布
  socket.on('wish:post', ({ author, text }) => {
    if (!author || !text) return;
    if (wishes.length >= 200) wishes.shift();
    wishes.push({ id: Date.now()+'_'+Math.random().toString(36).slice(2), author, text: String(text).slice(0,60), timestamp: Date.now(), hidden: false });
    saveWishes();
    io.emit('wish:all', wishes);
  });

  // 心愿条：删除（仅作者）
  socket.on('wish:delete', ({ author, id }) => {
    const idx = wishes.findIndex(w => w.id === id && w.author === author);
    if (idx === -1) return;
    wishes.splice(idx, 1);
    saveWishes();
    io.emit('wish:all', wishes);
  });

  // 心愿条：隐藏/显示（仅作者，不真正删除）
  socket.on('wish:hide', ({ author, id }) => {
    const w = wishes.find(w => w.id === id && w.author === author);
    if (!w) return;
    w.hidden = !w.hidden;
    saveWishes();
    io.emit('wish:all', wishes);
  });

  // 便利贴：删除（仅作者本人）
  socket.on('sticky:delete', ({ venue, noteId, author }) => {
    if (!stickyNotes[venue]) return;
    const idx = stickyNotes[venue].findIndex(n => n.id === noteId && n.author === author);
    if (idx === -1) return;
    stickyNotes[venue].splice(idx, 1);
    saveStickyNotes();
    io.emit('sticky:update', { venue, notes: stickyNotes[venue] });
  });

  socket.on('disconnect', () => {
    const p = onlinePlayers.get(socket.id);
    if (p) console.log(`✦ ${p.name} 离开小镇`);
    onlinePlayers.delete(socket.id);
    socket.broadcast.emit('player:leave', { id: socket.id });
  });
});

httpServer.listen(3000, () => {
  console.log('');
  console.log('✨ 像素小镇已开启！');
  console.log('🌐 请访问：http://localhost:3000');
  console.log('');
});
