// CAFELAX Signage Backend
// Node.js + Express
// 
// التشغيل:
//   npm install
//   npm start

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// STORAGE PATHS
// ============================================
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ============================================
// STATE
// ============================================
let state = {
  groups: {},
  screens: {},
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load state failed:', e); }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

loadState();

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '10mb' }));

// CORS for cross-origin requests
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Screen-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve uploads
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '30d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  }
}));

// Serve all HTML/JS files from root directory
app.use(express.static(__dirname));

// File upload config
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const hash = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${hash}${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================
// API: DISPLAY ENDPOINTS
// ============================================

app.get('/api/playlist', (req, res) => {
  const groupName = req.query.group;
  const clientVersion = req.query.v;
  
  if (!groupName) return res.status(400).json({ error: 'group required' });
  
  const group = state.groups[groupName];
  if (!group) {
    return res.json({
      version: '0',
      playlist: [],
      serverTime: Date.now()
    });
  }
  
  const response = {
    version: group.version,
    serverTime: Date.now()
  };
  
  if (clientVersion !== group.version) {
    response.playlist = group.playlist;
  }
  
  res.json(response);
});

app.post('/api/heartbeat', (req, res) => {
  const { group, version } = req.body;
  if (!group) return res.status(400).json({ error: 'group required' });
  
  const screenId = req.headers['x-screen-id'] || 
    crypto.createHash('md5').update(req.ip + req.headers['user-agent']).digest('hex').slice(0, 12);
  
  state.screens[screenId] = {
    group,
    version,
    lastSeen: Date.now(),
    ip: req.ip
  };
  
  saveState();
  res.json({ ok: true, screenId });
});

// ============================================
// API: ADMIN ENDPOINTS
// ============================================

app.get('/api/admin/state', (req, res) => {
  res.json(state);
});

app.post('/api/admin/upload', upload.array('files'), (req, res) => {
  const files = req.files.map(f => ({
    id: 'item_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
    name: f.originalname,
    url: `/uploads/${f.filename}`,
    type: f.mimetype.startsWith('video/') ? 'video' : 'image',
    size: f.size,
    duration: f.mimetype.startsWith('video/') ? 10000 : 5000,
    uploaded: Date.now()
  }));
  res.json({ files });
});

app.put('/api/admin/groups/:name/playlist', (req, res) => {
  const groupName = req.params.name;
  const { playlist } = req.body;
  
  if (!Array.isArray(playlist)) {
    return res.status(400).json({ error: 'playlist must be array' });
  }
  
  if (!state.groups[groupName]) {
    state.groups[groupName] = { playlist: [], version: '0' };
  }
  
  state.groups[groupName].playlist = playlist;
  state.groups[groupName].version = Date.now().toString();
  
  saveState();
  res.json({ 
    ok: true, 
    version: state.groups[groupName].version,
    itemCount: playlist.length
  });
});

app.post('/api/admin/groups', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  
  const clean = name.trim().toLowerCase().replace(/\s+/g, '-');
  if (state.groups[clean]) {
    return res.status(409).json({ error: 'group exists' });
  }
  
  state.groups[clean] = { playlist: [], version: '0' };
  saveState();
  res.json({ ok: true, name: clean });
});

app.delete('/api/admin/groups/:name', (req, res) => {
  delete state.groups[req.params.name];
  saveState();
  res.json({ ok: true });
});

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => res.redirect('/admin.html'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Cleanup
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  Object.keys(state.screens).forEach(id => {
    if (state.screens[id].lastSeen < cutoff) {
      delete state.screens[id];
    }
  });
  saveState();
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CAFELAX Signage running on port ${PORT}`);
});
