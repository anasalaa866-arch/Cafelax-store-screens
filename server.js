// CAFELAX Signage Backend v2
// Media Library + Playlists + Screen Management
// 
// التشغيل:
//   npm install
//   npm start

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// PERSISTENT STORAGE
// ============================================
const PERSISTENT_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || 
                       (fs.existsSync('/data') ? '/data' : path.join(__dirname));

const DATA_DIR = path.join(PERSISTENT_DIR, 'data');
const UPLOADS_DIR = path.join(PERSISTENT_DIR, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

console.log('Persistent storage at:', PERSISTENT_DIR);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ============================================
// STATE - NEW SCHEMA
// ============================================
// {
//   library: {
//     'media_xxx': {
//       id, name, url, type, size, width, height, uploaded
//     }
//   },
//   playlists: {
//     'pl_xxx': {
//       id, name, items: [{mediaId, duration}], schedules: [...]
//     }
//   },
//   screens: {
//     'screen_xxx': {
//       id, name, ip, userAgent, lastSeen, playlistId,
//       rotation, fitMode, registered
//     }
//   }
// }
let state = {
  library: {},
  playlists: {},
  screens: {},
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = {
        library: loaded.library || {},
        playlists: loaded.playlists || {},
        screens: loaded.screens || {}
      };
      console.log('State loaded:', 
        Object.keys(state.library).length, 'media,',
        Object.keys(state.playlists).length, 'playlists,',
        Object.keys(state.screens).length, 'screens'
      );
    }
  } catch (e) { console.error('Load state failed:', e); }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('Save failed:', e); }
}

loadState();

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
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

// Get image dimensions
async function getImageDimensions(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch (e) {
    return { width: 0, height: 0 };
  }
}

// Build playlist items with full media data
function buildPlaylistItems(playlist) {
  if (!playlist || !playlist.items) return [];
  return playlist.items
    .map(item => {
      const media = state.library[item.mediaId];
      if (!media) return null;
      return {
        id: item.mediaId,
        name: media.name,
        url: media.url,
        type: media.type,
        size: media.size,
        width: media.width,
        height: media.height,
        duration: item.duration || (media.type === 'video' ? 10000 : 5000)
      };
    })
    .filter(Boolean);
}

// Get active playlist for a screen (handles schedules)
function getScreenPlaylist(screen) {
  if (!screen.playlistId) return { items: [], source: 'none' };
  
  const playlist = state.playlists[screen.playlistId];
  if (!playlist) return { items: [], source: 'none' };
  
  const now = Date.now();
  
  // Check active schedule
  if (playlist.schedules && playlist.schedules.length) {
    const activeSchedule = playlist.schedules.find(s => {
      if (!s.active) return false;
      const start = new Date(s.startDate).getTime();
      const end = new Date(s.endDate).getTime();
      return now >= start && now <= end;
    });
    
    if (activeSchedule) {
      return {
        items: buildPlaylistItems({ items: activeSchedule.items }),
        source: 'schedule',
        scheduleName: activeSchedule.name,
        scheduleId: activeSchedule.id
      };
    }
  }
  
  return {
    items: buildPlaylistItems(playlist),
    source: 'default',
    playlistName: playlist.name
  };
}

function computePlaylistVersion(screen) {
  if (!screen.playlistId) return '0';
  const playlist = state.playlists[screen.playlistId];
  if (!playlist) return '0';
  
  const baseVersion = playlist.version || '0';
  const active = getScreenPlaylist(screen);
  if (active.source === 'schedule') {
    return `${baseVersion}_sch_${active.scheduleId}`;
  }
  return baseVersion;
}

function genScreenId(req) {
  return crypto.createHash('md5')
    .update(req.ip + (req.headers['user-agent'] || ''))
    .digest('hex')
    .slice(0, 12);
}

// ============================================
// API: DISPLAY (Screen-side)
// ============================================

// أول مرة الشاشة بتفتح، بتسجل نفسها
app.post('/api/register', (req, res) => {
  const { rotation, fitMode } = req.body;
  const screenId = genScreenId(req);
  
  const existing = state.screens[screenId];
  if (existing) {
    // تحديث المعلومات
    existing.lastSeen = Date.now();
    existing.ip = req.ip;
    existing.userAgent = req.headers['user-agent'];
    if (rotation !== undefined) existing.rotation = rotation;
    if (fitMode !== undefined) existing.fitMode = fitMode;
  } else {
    // شاشة جديدة
    state.screens[screenId] = {
      id: screenId,
      name: null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      lastSeen: Date.now(),
      registered: Date.now(),
      playlistId: null,
      rotation: rotation || 0,
      fitMode: fitMode || 'cover',
    };
  }
  
  saveState();
  res.json({ 
    screenId, 
    config: state.screens[screenId]
  });
});

// الشاشة بتسأل عن الـ playlist الخاص بيها
app.get('/api/screen/config', (req, res) => {
  const screenId = req.query.screenId || genScreenId(req);
  const clientVersion = req.query.v;
  
  const screen = state.screens[screenId];
  if (!screen) {
    return res.json({
      screenId,
      registered: false,
      serverTime: Date.now()
    });
  }
  
  // Update last seen
  screen.lastSeen = Date.now();
  screen.ip = req.ip;
  
  const active = getScreenPlaylist(screen);
  const effectiveVersion = computePlaylistVersion(screen);
  
  // Schedule next change
  let nextChange = null;
  if (screen.playlistId) {
    const playlist = state.playlists[screen.playlistId];
    if (playlist && playlist.schedules) {
      const now = Date.now();
      if (active.source === 'schedule') {
        const sch = playlist.schedules.find(s => s.id === active.scheduleId);
        if (sch) nextChange = new Date(sch.endDate).getTime();
      } else {
        const upcoming = playlist.schedules
          .filter(s => s.active && new Date(s.startDate).getTime() > now)
          .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
        if (upcoming) nextChange = new Date(upcoming.startDate).getTime();
      }
    }
  }
  
  saveState();
  
  const response = {
    screenId,
    registered: true,
    name: screen.name,
    rotation: screen.rotation,
    fitMode: screen.fitMode,
    version: effectiveVersion,
    serverTime: Date.now(),
    source: active.source,
    nextChange,
  };
  
  if (active.scheduleName) response.scheduleName = active.scheduleName;
  
  if (clientVersion !== effectiveVersion) {
    response.playlist = active.items;
  }
  
  res.json(response);
});

// Heartbeat
app.post('/api/heartbeat', (req, res) => {
  const screenId = req.headers['x-screen-id'] || genScreenId(req);
  
  if (state.screens[screenId]) {
    state.screens[screenId].lastSeen = Date.now();
    state.screens[screenId].ip = req.ip;
    saveState();
  }
  
  res.json({ ok: true });
});

// ============================================
// API: ADMIN - STATE
// ============================================
app.get('/api/admin/state', (req, res) => {
  res.json(state);
});

// ============================================
// API: ADMIN - MEDIA LIBRARY
// ============================================
app.post('/api/admin/library/upload', upload.array('files'), async (req, res) => {
  const items = [];
  
  for (const f of req.files) {
    const id = 'media_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const isImage = f.mimetype.startsWith('image/');
    const isVideo = f.mimetype.startsWith('video/');
    
    let dimensions = { width: 0, height: 0 };
    if (isImage) {
      dimensions = await getImageDimensions(f.path);
    }
    
    const media = {
      id,
      name: f.originalname,
      url: `/uploads/${f.filename}`,
      filename: f.filename,
      type: isVideo ? 'video' : 'image',
      mimeType: f.mimetype,
      size: f.size,
      width: dimensions.width,
      height: dimensions.height,
      uploaded: Date.now()
    };
    
    state.library[id] = media;
    items.push(media);
  }
  
  saveState();
  res.json({ items });
});

app.put('/api/admin/library/:id', (req, res) => {
  const media = state.library[req.params.id];
  if (!media) return res.status(404).json({ error: 'not found' });
  
  const { name } = req.body;
  if (name) media.name = name;
  
  saveState();
  res.json({ ok: true, media });
});

app.delete('/api/admin/library/:id', (req, res) => {
  const media = state.library[req.params.id];
  if (!media) return res.status(404).json({ error: 'not found' });
  
  // Delete file
  try {
    const filePath = path.join(UPLOADS_DIR, media.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) { console.warn('Failed to delete file:', e.message); }
  
  // Remove from playlists too
  Object.values(state.playlists).forEach(pl => {
    pl.items = pl.items.filter(item => item.mediaId !== req.params.id);
    if (pl.schedules) {
      pl.schedules.forEach(sch => {
        sch.items = (sch.items || []).filter(item => item.mediaId !== req.params.id);
      });
    }
    pl.version = Date.now().toString();
  });
  
  delete state.library[req.params.id];
  saveState();
  res.json({ ok: true });
});

// Rotate image
app.post('/api/admin/library/:id/rotate', async (req, res) => {
  const media = state.library[req.params.id];
  if (!media) return res.status(404).json({ error: 'not found' });
  if (media.type !== 'image') return res.status(400).json({ error: 'only images can be rotated' });
  
  const { angle } = req.body; // 90, 180, 270
  if (![90, 180, 270].includes(angle)) {
    return res.status(400).json({ error: 'invalid angle' });
  }
  
  try {
    const filePath = path.join(UPLOADS_DIR, media.filename);
    const tempPath = filePath + '.tmp';
    
    await sharp(filePath)
      .rotate(angle)
      .toFile(tempPath);
    
    fs.renameSync(tempPath, filePath);
    
    // Update dimensions
    const newDimensions = await getImageDimensions(filePath);
    media.width = newDimensions.width;
    media.height = newDimensions.height;
    
    // Force cache bust by updating URL with version
    const baseUrl = media.url.split('?')[0];
    media.url = baseUrl + '?v=' + Date.now();
    
    // Update playlists versions
    Object.values(state.playlists).forEach(pl => {
      const hasMedia = pl.items.some(item => item.mediaId === req.params.id);
      if (hasMedia) pl.version = Date.now().toString();
    });
    
    saveState();
    res.json({ ok: true, media });
  } catch (err) {
    console.error('Rotate failed:', err);
    res.status(500).json({ error: 'rotation failed: ' + err.message });
  }
});

// ============================================
// API: ADMIN - PLAYLISTS
// ============================================
app.post('/api/admin/playlists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  
  const id = 'pl_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  state.playlists[id] = {
    id,
    name: name.trim(),
    items: [],
    schedules: [],
    version: Date.now().toString(),
    created: Date.now()
  };
  
  saveState();
  res.json({ ok: true, playlist: state.playlists[id] });
});

app.put('/api/admin/playlists/:id', (req, res) => {
  const pl = state.playlists[req.params.id];
  if (!pl) return res.status(404).json({ error: 'not found' });
  
  const { name, items } = req.body;
  if (name !== undefined) pl.name = name.trim();
  if (Array.isArray(items)) {
    pl.items = items.map(i => ({
      mediaId: i.mediaId,
      duration: parseInt(i.duration) || 5000
    }));
  }
  pl.version = Date.now().toString();
  
  saveState();
  res.json({ ok: true, playlist: pl });
});

app.delete('/api/admin/playlists/:id', (req, res) => {
  if (!state.playlists[req.params.id]) {
    return res.status(404).json({ error: 'not found' });
  }
  
  // Unassign from screens
  Object.values(state.screens).forEach(s => {
    if (s.playlistId === req.params.id) s.playlistId = null;
  });
  
  delete state.playlists[req.params.id];
  saveState();
  res.json({ ok: true });
});

// Schedules
app.post('/api/admin/playlists/:id/schedules', (req, res) => {
  const pl = state.playlists[req.params.id];
  if (!pl) return res.status(404).json({ error: 'playlist not found' });
  
  const { id, name, items, startDate, endDate, active } = req.body;
  
  if (!name || !startDate || !endDate || !Array.isArray(items)) {
    return res.status(400).json({ error: 'missing fields' });
  }
  
  if (new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ error: 'end must be after start' });
  }
  
  if (!pl.schedules) pl.schedules = [];
  
  const scheduleData = {
    name,
    items: items.map(i => ({
      mediaId: i.mediaId,
      duration: parseInt(i.duration) || 5000
    })),
    startDate,
    endDate,
    active: active !== false
  };
  
  if (id) {
    const idx = pl.schedules.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'schedule not found' });
    pl.schedules[idx] = { ...pl.schedules[idx], ...scheduleData };
  } else {
    pl.schedules.push({
      id: 'sch_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
      ...scheduleData,
      created: Date.now()
    });
  }
  
  pl.version = Date.now().toString();
  saveState();
  res.json({ ok: true });
});

app.delete('/api/admin/playlists/:id/schedules/:scheduleId', (req, res) => {
  const pl = state.playlists[req.params.id];
  if (!pl || !pl.schedules) return res.status(404).json({ error: 'not found' });
  
  pl.schedules = pl.schedules.filter(s => s.id !== req.params.scheduleId);
  pl.version = Date.now().toString();
  saveState();
  res.json({ ok: true });
});

app.patch('/api/admin/playlists/:id/schedules/:scheduleId', (req, res) => {
  const pl = state.playlists[req.params.id];
  if (!pl || !pl.schedules) return res.status(404).json({ error: 'not found' });
  
  const sch = pl.schedules.find(s => s.id === req.params.scheduleId);
  if (!sch) return res.status(404).json({ error: 'schedule not found' });
  
  if (req.body.active !== undefined) sch.active = !!req.body.active;
  pl.version = Date.now().toString();
  saveState();
  res.json({ ok: true });
});

// ============================================
// API: ADMIN - SCREENS
// ============================================
app.put('/api/admin/screens/:id', (req, res) => {
  const screen = state.screens[req.params.id];
  if (!screen) return res.status(404).json({ error: 'not found' });
  
  const { name, playlistId, rotation, fitMode } = req.body;
  if (name !== undefined) screen.name = name;
  if (playlistId !== undefined) screen.playlistId = playlistId || null;
  if (rotation !== undefined) screen.rotation = parseInt(rotation);
  if (fitMode !== undefined) screen.fitMode = fitMode;
  
  saveState();
  res.json({ ok: true, screen });
});

app.delete('/api/admin/screens/:id', (req, res) => {
  delete state.screens[req.params.id];
  saveState();
  res.json({ ok: true });
});

// ============================================
// BACKUP
// ============================================
app.get('/api/admin/backup', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="cafelax-backup-${Date.now()}.json"`);
  res.json(state);
});

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => res.redirect('/admin.html'));
app.get('/health', (req, res) => res.json({ 
  status: 'ok',
  time: Date.now(),
  storage: PERSISTENT_DIR,
  library: Object.keys(state.library).length,
  playlists: Object.keys(state.playlists).length,
  screens: Object.keys(state.screens).length
}));

// Cleanup
setInterval(() => {
  // Remove old expired schedules (>30 days)
  const oldCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  Object.values(state.playlists).forEach(pl => {
    if (pl.schedules) {
      pl.schedules = pl.schedules.filter(s => 
        new Date(s.endDate).getTime() > oldCutoff
      );
    }
  });
  saveState();
}, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CAFELAX Signage v2 running on port ${PORT}`);
});
