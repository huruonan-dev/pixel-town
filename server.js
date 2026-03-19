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
