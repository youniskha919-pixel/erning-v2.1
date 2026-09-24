const express = require('express');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const MONGO_URI = process.env.MONGO_URI || '';
const MONGO_DB = process.env.MONGO_DB || 'miniapp';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';

let mongoClient = null;
let mongoDb = null;

async function connectMongo() {
  if (!MONGO_URI) return null;
  if (mongoClient && mongoDb) return mongoDb;
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGO_DB);
  return mongoDb;
}

async function readUsersCollection() {
  const db = await connectMongo();
  if (!db) return null;
  return db.collection('users');
}

async function readWithdrawalsCollection() {
  const db = await connectMongo();
  if (!db) return null;
  return db.collection('withdrawals');
}

async function readTasksCollection() {
  const db = await connectMongo();
  if (!db) return null;
  return db.collection('tasks');
}

app.use(express.json());

function readStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return { users: [], withdrawals: [], tasks: [] };
  }
}

function saveStore() {
  const snapshot = {
    users: Array.from(users.values()),
    withdrawals,
    tasks: Array.from(tasks.values())
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
}

async function persistToMongo() {
  const usersCollection = await readUsersCollection();
  const withdrawalsCollection = await readWithdrawalsCollection();
  const tasksCollection = await readTasksCollection();

  if (!usersCollection || !withdrawalsCollection || !tasksCollection) return;

  const snapshotUsers = Array.from(users.values());
  const snapshotTasks = Array.from(tasks.values());

  await Promise.all([
    usersCollection.deleteMany({}),
    withdrawalsCollection.deleteMany({}),
    tasksCollection.deleteMany({})
  ]);

  if (snapshotUsers.length) await usersCollection.insertMany(snapshotUsers);
  if (withdrawals.length) await withdrawalsCollection.insertMany(withdrawals);
  if (snapshotTasks.length) await tasksCollection.insertMany(snapshotTasks);
}

async function syncStoreToMongo() {
  if (!MONGO_URI) return;
  try {
    await persistToMongo();
  } catch (error) {
    console.warn('Mongo persistence failed:', error.message);
  }
}

function initFirebase() {
  if (!FIREBASE_SERVICE_ACCOUNT) return null;
  if (admin.apps.length) return admin.database();

  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
    });
    return admin.database();
  } catch (error) {
    console.warn('Firebase config failed:', error.message);
    return null;
  }
}

let firebaseDb = initFirebase();

async function syncStoreToFirebase() {
  if (!firebaseDb) return;

  try {
    await firebaseDb.ref('users').set(Object.fromEntries(users));
    await firebaseDb.ref('withdrawals').set(withdrawals);
    await firebaseDb.ref('tasks').set(Object.fromEntries(tasks));
  } catch (error) {
    console.warn('Firebase sync failed:', error.message);
  }
}

const initialStore = readStore();
const users = new Map((initialStore.users || []).map(user => [String(user.id), user]));
const withdrawals = Array.isArray(initialStore.withdrawals) ? initialStore.withdrawals : [];
const tasks = new Map((initialStore.tasks || []).map(task => [String(task.id), task]));

function getOrCreateUser(userId, name = 'Guest') {
  const key = String(userId || 'guest');
  if (!users.has(key)) {
    users.set(key, {
      id: key,
      name,
      balance: 0,
      referrals: 0,
      tasksDone: 0,
      streak: 0,
      completedTasks: [],
      createdAt: new Date().toISOString()
    });
    saveStore();
    syncStoreToMongo();
    syncStoreToFirebase();
  }

  const user = users.get(key);
  if (name && user.name === 'Guest') user.name = name;
  return user;
}

function buildTaskListForUser(userId) {
  const cleaned = Array.from(tasks.values()).map(task => ({
    id: task.id,
    title: task.title,
    reward: task.reward,
    isCompleted: task.completedBy.includes(String(userId || 'guest'))
  }));
  return cleaned;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, users: users.size, withdrawals: withdrawals.length });
});

app.get('/api/user/:id', (req, res) => {
  const user = getOrCreateUser(req.params.id, 'Guest');
  res.json({ user: { ...user, tasks: buildTaskListForUser(user.id) } });
});

app.post('/api/auth/telegram', (req, res) => {
  const initData = String(req.body?.initData || '');
  if (!initData) {
    return res.status(400).json({ error: 'Telegram init data missing' });
  }

  const params = new URLSearchParams(initData);
  const rawUser = params.get('user');
  if (!rawUser) {
    return res.status(400).json({ error: 'Telegram user payload missing' });
  }

  let parsedUser = null;
  try {
    parsedUser = JSON.parse(rawUser);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid Telegram payload' });
  }

  const userId = String(parsedUser.id || 'guest');
  const user = getOrCreateUser(userId, parsedUser.first_name || parsedUser.username || 'Telegram user');
  user.name = parsedUser.first_name || parsedUser.username || user.name;
  user.username = parsedUser.username || user.username || '';
  user.avatar = parsedUser.photo_url || user.avatar || '';
  user.telegramData = { ...parsedUser, authDate: new Date().toISOString() };
  saveStore();
  syncStoreToFirebase();

  res.json({ ok: true, user: { ...user, tasks: buildTaskListForUser(user.id) } });
});

app.post('/api/user', (req, res) => {
  const { userId, name } = req.body || {};
  const user = getOrCreateUser(userId, name || 'Guest');
  res.json({ user: { ...user, tasks: buildTaskListForUser(user.id) } });
});

app.get('/api/tasks', (req, res) => {
  const userId = req.query.userId || 'guest';
  res.json({ tasks: buildTaskListForUser(userId) });
});

app.post('/api/task-complete', (req, res) => {
  const { userId, taskId, amount, title } = req.body || {};
  const parsedAmount = Number(amount || 0);
  if (!taskId || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid task reward' });
  }

  const user = getOrCreateUser(userId, 'Guest');
  const normalizedUserId = String(user.id);
  const existingTask = tasks.get(taskId) || {
    id: taskId,
    title: title || 'Task reward',
    reward: parsedAmount,
    completedBy: []
  };

  if (!existingTask.completedBy.includes(normalizedUserId)) {
    existingTask.completedBy.push(normalizedUserId);
    tasks.set(taskId, existingTask);
    user.balance += parsedAmount;
    user.tasksDone += 1;
    user.streak += 1;
    user.completedTasks = Array.from(new Set([...user.completedTasks, taskId]));
    saveStore();
    syncStoreToMongo();
    syncStoreToFirebase();
  }

  res.json({ ok: true, balance: user.balance, task: { ...existingTask }, user: { ...user, tasks: buildTaskListForUser(user.id) } });
});

app.post('/api/earn', (req, res) => {
  const { userId, amount } = req.body || {};
  const parsedAmount = Number(amount || 0);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const user = getOrCreateUser(userId, 'Guest');
  user.balance += parsedAmount;
  user.tasksDone += 1;
  user.streak += 1;
  saveStore();
  syncStoreToMongo();
  syncStoreToFirebase();

  res.json({ ok: true, balance: user.balance, user: { ...user, tasks: buildTaskListForUser(user.id) } });
});

app.post('/api/redeem', (req, res) => {
  const { code } = req.body || {};
  const normalized = String(code || '').trim();

  if (!normalized) {
    return res.status(400).json({ error: 'Code required' });
  }

  const bonusMap = {
    MSCOIN100: 100,
    SPRING50: 50,
    VIP25: 25,
    START200: 200,
    HELLO10: 10
  };

  const bonus = bonusMap[normalized.toUpperCase()];
  if (!bonus) {
    return res.status(400).json({ error: 'Invalid promo code' });
  }

  const userId = req.body.userId || 'guest';
  const user = getOrCreateUser(userId, 'Guest');
  user.balance += bonus;
  saveStore();
  syncStoreToMongo();
  syncStoreToFirebase();

  res.json({ ok: true, bonus, balance: user.balance, user: { ...user } });
});

app.post('/api/withdraw', (req, res) => {
  const { userId, gateway, amount, wallet } = req.body || {};
  const parsedAmount = Number(amount || 0);

  if (!gateway || !wallet || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Missing withdraw details' });
  }

  const user = getOrCreateUser(userId, 'Guest');
  if (parsedAmount > user.balance) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  user.balance -= parsedAmount;
  const request = {
    id: `wd-${Date.now()}`,
    userId: user.id,
    gateway,
    amount: parsedAmount,
    wallet,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  withdrawals.push(request);
  saveStore();
  syncStoreToMongo();
  syncStoreToFirebase();
  res.json({ ok: true, request, balance: user.balance, withdrawals });
});

app.get('/api/withdrawals', (req, res) => {
  const userId = req.query.userId;
  if (userId) {
    return res.json({ withdrawals: withdrawals.filter(item => String(item.userId) === String(userId)) });
  }
  res.json({ withdrawals });
});

app.get('/api/admin/withdrawals', (_req, res) => {
  res.json({ withdrawals });
});

app.post('/api/admin/withdrawals/:id/:status', (req, res) => {
  const { id, status } = req.params;
  const allowed = ['pending', 'approved', 'rejected'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const index = withdrawals.findIndex(item => String(item.id) === String(id));
  if (index === -1) {
    return res.status(404).json({ error: 'Withdrawal not found' });
  }

  withdrawals[index].status = status;
  saveStore();
  syncStoreToMongo();
  syncStoreToFirebase();
  res.json({ ok: true, withdrawal: withdrawals[index] });
});

app.post('/api/referral', (req, res) => {
  const { userId, refId } = req.body || {};
  const user = getOrCreateUser(userId, 'Guest');
  const referrer = getOrCreateUser(refId, 'Guest');
  referrer.balance += 250;
  referrer.referrals += 1;
  user.balance += 50;
  saveStore();
  syncStoreToMongo();
  syncStoreToFirebase();

  res.json({ ok: true, bonus: 50, referrerBalance: referrer.balance, userBalance: user.balance });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index (4).html'));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
