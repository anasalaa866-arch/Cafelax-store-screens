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
// Schema:
// state.groups[name] = {
//   playlist: [...],          ← القائمة الأساسية
//   version: '...',
//   schedules: [              ← قوائم مؤقتة
//     {
//       id: 'sch_...',
//       name: 'حملة رمضان',
//       playlist: [...],
//       startDate: '2025-03-01T00:00:00',
//       endDate: '2025-04-01T00:00:00',
//       active: true
//     }
//   ]
// }
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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Screen-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: '30d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  }
}));

app.use(express.static(__dirname));

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
// HELPERS
// ============================================

// يحدد القائمة النشطة دلوقتي (الأساسية أو schedule)
function getActivePlaylist(group) {
  const now = Date.now();
  
  // ابحث عن schedule نشط
  if (group.schedules && group.schedules.length) {
    const activeSchedule = group.schedules.find(s => {
      if (!s.active) return false;
      const start = new Date(s.startDate).getTime();
      const end = new Date(s.endDate).getTime();
      return now >= start && now <= end;
    });
    
    if (activeSchedule) {
      return {
        playlist: activeSchedule.playlist,
        source: 'schedule',
        scheduleId: activeSchedule.id,
        scheduleName: activeSchedule.name
      };
    }
  }
  
  // الافتراضي: القائمة الأساسية
  return {
    playlist: group.playlist || [],
    source: 'default'
  };
}

// نسخة version متغيرة بناءً على الوقت والـ schedules
function computeEffectiveVersion(group) {
  const active = getActivePlaylist(group);
  const baseVersion = group.version || '0';
  if (active.source === 'schedule') {
    return `${baseVersion}_sch_${active.scheduleId}`;
  }
  return baseVersion;
}

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
  
  const active = getActivePlaylist(group);
  const effectiveVersion = computeEffectiveVersion(group);
  
  // حساب وقت انتهاء الـ schedule لو فيه
  let nextChange = null;
  if (active.source === 'schedule') {
    const schedule = group.schedules.find(s => s.id === active.scheduleId);
    if (schedule) nextChange = new Date(schedule.endDate).getTime();
  } else if (group.schedules && group.schedules.length) {
    // ابحث عن أقرب schedule هيبدأ
    const now = Date.now();
    const upcoming = group.schedules
      .filter(s => s.active && new Date(s.startDate).getTime() > now)
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
    if (upcoming) nextChange = new Date(upcoming.startDate).getTime();
  }
  
  const response = {
    version: effectiveVersion,
    serverTime: Date.now(),
    source: active.source,
    nextChange: nextChange
  };
  
  if (active.source === 'schedule') {
    response.scheduleName = active.scheduleName;
  }
  
  if (clientVersion !== effectiveVersion) {
    response.playlist = active.playlist;
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

// تحديث القائمة الأساسية
app.put('/api/admin/groups/:name/playlist', (req, res) => {
  const groupName = req.params.name;
  const { playlist } = req.body;
  
  if (!Array.isArray(playlist)) {
    return res.status(400).json({ error: 'playlist must be array' });
  }
  
  if (!state.groups[groupName]) {
    state.groups[groupName] = { playlist: [], version: '0', schedules: [] };
  }
  
  state.groups[groupName].playlist = playlist;
  state.groups[groupName].version = Date.now().toString();
  if (!state.groups[groupName].schedules) state.groups[groupName].schedules = [];
  
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
  
  state.groups[clean] = { playlist: [], version: '0', schedules: [] };
  saveState();
  res.json({ ok: true, name: clean });
});

app.delete('/api/admin/groups/:name', (req, res) => {
  delete state.groups[req.params.name];
  saveState();
  res.json({ ok: true });
});

// ============================================
// API: SCHEDULES
// ============================================

// إنشاء أو تحديث schedule
app.post('/api/admin/groups/:name/schedules', (req, res) => {
  const groupName = req.params.name;
  const { id, name, playlist, startDate, endDate, active } = req.body;
  
  if (!state.groups[groupName]) {
    return res.status(404).json({ error: 'group not found' });
  }
  
  if (!name || !startDate || !endDate || !Array.isArray(playlist)) {
    return res.status(400).json({ error: 'missing fields' });
  }
  
  if (new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ error: 'end date must be after start date' });
  }
  
  if (!state.groups[groupName].schedules) {
    state.groups[groupName].schedules = [];
  }
  
  if (id) {
    // تحديث موجود
    const idx = state.groups[groupName].schedules.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'schedule not found' });
    
    state.groups[groupName].schedules[idx] = {
      ...state.groups[groupName].schedules[idx],
      name, playlist, startDate, endDate,
      active: active !== false
    };
  } else {
    // إضافة جديد
    state.groups[groupName].schedules.push({
      id: 'sch_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      name,
      playlist,
      startDate,
      endDate,
      active: active !== false,
      created: Date.now()
    });
  }
  
  state.groups[groupName].version = Date.now().toString();
  saveState();
  res.json({ ok: true });
});

// حذف schedule
app.delete('/api/admin/groups/:name/schedules/:scheduleId', (req, res) => {
  const groupName = req.params.name;
  const scheduleId = req.params.scheduleId;
  
  if (!state.groups[groupName] || !state.groups[groupName].schedules) {
    return res.status(404).json({ error: 'not found' });
  }
  
  state.groups[groupName].schedules = state.groups[groupName].schedules.filter(s => s.id !== scheduleId);
  state.groups[groupName].version = Date.now().toString();
  saveState();
  res.json({ ok: true });
});

// تفعيل/تعطيل schedule
app.patch('/api/admin/groups/:name/schedules/:scheduleId', (req, res) => {
  const groupName = req.params.name;
  const scheduleId = req.params.scheduleId;
  const { active } = req.body;
  
  if (!state.groups[groupName] || !state.groups[groupName].schedules) {
    return res.status(404).json({ error: 'not found' });
  }
  
  const schedule = state.groups[groupName].schedules.find(s => s.id === scheduleId);
  if (!schedule) return res.status(404).json({ error: 'schedule not found' });
  
  schedule.active = !!active;
  state.groups[groupName].version = Date.now().toString();
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
  
  // امسح الـ schedules المنتهية أكتر من 30 يوم
  const oldCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  Object.values(state.groups).forEach(group => {
    if (group.schedules) {
      group.schedules = group.schedules.filter(s => 
        new Date(s.endDate).getTime() > oldCutoff
      );
    }
  });
  
  saveState();
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CAFELAX Signage running on port ${PORT}`);
});
