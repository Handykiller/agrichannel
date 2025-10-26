// server.js - production-ready for AgriChannel
require('dotenv').config();
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const { Sequelize, DataTypes } = require('sequelize');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const STORAGE_PATH = path.join(DATA_DIR, 'database.sqlite');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

// ensure folders exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

(async () => {
  // Setup Sequelize with SQLite
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: STORAGE_PATH,
    logging: false,
    pool: { max: 1, min: 0, acquire: 30000, idle: 10000 }
  });

  try {
    await sequelize.authenticate();
    console.log('Sequelize connected to SQLite at', STORAGE_PATH);
  } catch (err) {
    console.error('Sequelize authenticate error:', err);
    process.exit(1);
  }

  // set pragmas to reduce locking issues
  try {
    await sequelize.query('PRAGMA journal_mode = WAL;');
    await sequelize.query('PRAGMA synchronous = NORMAL;');
    await sequelize.query('PRAGMA foreign_keys = ON;');
    await sequelize.query('PRAGMA busy_timeout = 5000;');
    console.log('SQLite PRAGMAs applied (WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000)');
  } catch (e) {
    console.warn('Warning: could not set PRAGMA values', e && e.message);
  }

  // Models
  const User = sequelize.define('User', {
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    passwordSig: { type: DataTypes.STRING, allowNull: false, unique: true }
  });

  const Post = sequelize.define('Post', {
    itemName: { type: DataTypes.STRING, allowNull: false },
    image: { type: DataTypes.STRING, allowNull: true },
    location: { type: DataTypes.STRING, allowNull: true },
    phone: { type: DataTypes.STRING, allowNull: true },
    price: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    ownerUserId: { type: DataTypes.INTEGER, allowNull: false }
  });

  User.hasMany(Post, { foreignKey: 'ownerUserId' });
  Post.belongsTo(User, { foreignKey: 'ownerUserId' });

  // Sync DB
  try {
    await sequelize.sync();
    console.log('Database synced (tables created/updated)');
  } catch (err) {
    console.error('Sequelize sync error:', err);
    process.exit(1);
  }

  // Express app + server + socket.io
  const app = express();
  const server = http.createServer(app);
  const io = require('socket.io')(server, { cors: { origin: '*' } });

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(PUBLIC_DIR));
  app.use('/uploads', express.static(UPLOADS_DIR));

  // multer for file uploads (images)
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      cb(null, name);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
    fileFilter: (req, file, cb) => {
      const allowed = /jpeg|jpg|png|webp/;
      const ok = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase());
      cb(ok ? null : new Error('Invalid file type'), ok);
    }
  });

  // utils
  function makePasswordSig(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
  }
  function generateToken(user) {
    return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  }
  async function verifyTokenFromHeader(req) {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const token = auth.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return await User.findByPk(decoded.id);
    } catch (err) {
      return null;
    }
  }

  // routes
  app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

  app.get('/debug/dbstatus', (req, res) => {
    const exists = fs.existsSync(STORAGE_PATH);
    let size = null;
    try { if (exists) size = fs.statSync(STORAGE_PATH).size; } catch (e) {}
    res.json({ storagePath: STORAGE_PATH, exists, sizeBytes: size, nodeEnv: NODE_ENV });
  });

  // list posts (public) - return absolute image URLs
  app.get('/api/posts', async (req, res) => {
    try {
      const posts = await Post.findAll({ order: [['createdAt', 'DESC']], raw: true });
      const mapped = posts.map(p => ({
        ...p,
        image: p.image ? `${req.protocol}://${req.get('host')}/uploads/${p.image}` : null
      }));
      res.json(mapped);
    } catch (err) {
      console.error('GET /api/posts error:', err && err.stack || err);
      res.status(500).json({ error: NODE_ENV === 'production' ? 'Database error' : err && err.message });
    }
  });

  // create post (auth + file upload)
  app.post('/api/posts', upload.single('image'), async (req, res) => {
    try {
      const user = await verifyTokenFromHeader(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { itemName, location, phone, price, description } = req.body;
      if (!itemName || itemName.trim() === '') return res.status(400).json({ error: 'Item name is required.' });

      const imageFilename = req.file ? req.file.filename : null;

      const post = await Post.create({
        itemName: itemName.trim(),
        image: imageFilename,
        location: location || '',
        phone: phone || '',
        price: price || '',
        description: description || '',
        ownerUserId: user.id
      });

      const out = {
        id: post.id,
        itemName: post.itemName,
        image: post.image ? `${req.protocol}://${req.get('host')}/uploads/${post.image}` : null,
        location: post.location,
        phone: post.phone,
        price: post.price,
        description: post.description,
        ownerUserId: post.ownerUserId,
        createdAt: post.createdAt
      };

      io.emit('new_post', out);
      res.json(out);
    } catch (err) {
      console.error('POST /api/posts error:', err && err.stack || err);
      res.status(500).json({ error: NODE_ENV === 'production' ? 'Database error' : err && err.message });
    }
  });

  // register
  app.post('/api/register', async (req, res) => {
    try {
      const { password } = req.body;
      if (!password || typeof password !== 'string' || password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      }
      const sig = makePasswordSig(password);
      const existing = await User.findOne({ where: { passwordSig: sig } });
      if (existing) return res.status(409).json({ error: 'An account with that password already exists.' });

      const hash = await bcrypt.hash(password, 10);
      const user = await User.create({ passwordHash: hash, passwordSig: sig });
      const token = generateToken(user);
      res.json({ userId: user.id, token });
    } catch (err) {
      console.error('POST /api/register error:', err && err.stack || err);
      res.status(500).json({ error: NODE_ENV === 'production' ? 'Server error' : err && err.message });
    }
  });

  // login
  app.post('/api/login', async (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Password required.' });
      const sig = makePasswordSig(password);
      const user = await User.findOne({ where: { passwordSig: sig } });
      if (!user) return res.status(401).json({ error: 'Invalid password.' });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Invalid password.' });
      const token = generateToken(user);
      res.json({ userId: user.id, token });
    } catch (err) {
      console.error('POST /api/login error:', err && err.stack || err);
      res.status(500).json({ error: NODE_ENV === 'production' ? 'Server error' : err && err.message });
    }
  });

  // delete post (owner only)
  app.delete('/api/posts/:id', async (req, res) => {
    try {
      const user = await verifyTokenFromHeader(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const post = await Post.findByPk(req.params.id);
      if (!post) return res.status(404).json({ error: 'Post not found' });
      if (post.ownerUserId !== user.id) return res.status(403).json({ error: 'Not allowed to delete this post' });

      if (post.image) {
        const filepath = path.join(UPLOADS_DIR, post.image);
        try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (e) { console.warn('Failed to delete image file', e && e.message); }
      }
      await post.destroy();
      io.emit('deleted_post', { id: parseInt(req.params.id, 10) });
      res.json({ ok: true });
    } catch (err) {
      console.error('DELETE /api/posts/:id error:', err && err.stack || err);
      res.status(500).json({ error: NODE_ENV === 'production' ? 'Database error' : err && err.message });
    }
  });

  // Socket: online count
  let online = 0;
  io.on('connection', (socket) => {
    online++;
    io.emit('online_count', online);
    socket.on('disconnect', () => {
      online = Math.max(0, online - 1);
      io.emit('online_count', online);
    });
  });
  setInterval(()=> io.emit('online_count', online), 1000);

  // server self-ping (keepalive for some hosts)
  setInterval(() => {
    try {
      const options = { hostname: 'localhost', port: PORT, path: '/ping', method: 'GET', timeout: 2000 };
      const r = http.request(options, (res) => {});
      r.on('error', ()=>{});
      r.end();
    } catch (e) {}
  }, 1000 * 60 * 4);

  // Start server
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}  | Debug: http://localhost:${PORT}/debug/dbstatus`);
  });

})();
