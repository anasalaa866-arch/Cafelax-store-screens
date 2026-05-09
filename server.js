// CAFELAX Signage Backend v2.1
// Now with PostgreSQL persistent database
//
// Required env vars on Railway:
//   DATABASE_URL (auto-provided when you add PostgreSQL service)
//   RAILWAY_VOLUME_MOUNT_PATH (auto-provided when you add Volume)

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// PERSISTENT STORAGE FOR FILES
// ============================================
const PERSISTENT_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || 
                       (fs.existsSync('/data') ? '/data' : path.join(__dirname));
const UPLOADS_DIR = path.join(PERSISTENT_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log('Files stored at:', UPLOADS_DIR);

// ============================================
// POSTGRESQL CONNECTION
// ============================================
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required!');
  console.error('Add a PostgreSQL service in Railway and connect it to this service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

console.log('Connected to PostgreSQL');

// ============================================
// DATABASE SCHEMA
// ============================================
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        filename TEXT NOT NULL,
        type TEXT NOT NULL,
        mime_type TEXT,
        size BIGINT,
        width INT DEFAULT 0,
        height INT DEFAULT 0,
        uploaded BIGINT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        items JSONB DEFAULT '[]'::jsonb,
        schedules JSONB DEFAULT '[]'::jsonb,
        version TEXT NOT NULL,
        created BIGINT NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS screens (
        id TEXT PRIMARY KEY,
        name TEXT,
        ip TEXT,
        user_agent TEXT,
        last_seen BIGINT NOT NULL,
        registered BIGINT NOT NULL,
        playlist_id TEXT,
        rotation INT DEFAULT 0,
        fit_mode TEXT DEFAULT 'cover'
      );
      
      CREATE INDEX IF NOT EXISTS idx_media_uploaded ON media(uploaded DESC);
      CREATE INDEX IF NOT EXISTS idx_screens_last_seen ON screens(last_seen DESC);
    `);
    console.log('Database schema ready');
  } finally {
    client.release();
  }
}

// ============================================
// DATA ACCESS LAYER
// ============================================
const db = {
  // MEDIA
  async getAllMedia() {
    const { rows } = await pool.query('SELECT * FROM media ORDER BY uploaded DESC');
    return rows.map(rowToMedia);
  },
  
  async getMedia(id) {
    const { rows } = await pool.query('SELECT * FROM media WHERE id = $1', [id]);
    return rows[0] ? rowToMedia(rows[0]) : null;
  },
  
  async insertMedia(m) {
    await pool.query(`
      INSERT INTO media (id, name, url, filename, type, mime_type, size, width, height, uploaded)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [m.id, m.name, m.url, m.filename, m.type, m.mimeType, m.size, m.width, m.height, m.uploaded]);
  },
  
  async updateMedia(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    
    if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    if (updates.url !== undefined) { fields.push(`url = $${idx++}`); values.push(updates.url); }
    if (updates.width !== undefined) { fields.push(`width = $${idx++}`); values.push(updates.width); }
    if (updates.height !== undefined) { fields.push(`height = $${idx++}`); values.push(updates.height); }
    
    if (!fields.length) return;
    values.push(id);
    
    await pool.query(`UPDATE media SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  },
  
  async deleteMedia(id) {
    await pool.query('DELETE FROM media WHERE id = $1', [id]);
  },
  
  // PLAYLISTS
  async getAllPlaylists() {
    const { rows } = await pool.query('SELECT * FROM playlists ORDER BY created DESC');
    return rows.map(rowToPlaylist);
  },
  
  async getPlaylist(id) {
    const { rows } = await pool.query('SELECT * FROM playlists WHERE id = $1', [id]);
    return rows[0] ? rowToPlaylist(rows[0]) : null;
  },
  
  async insertPlaylist(pl) {
    await pool.query(`
      INSERT INTO playlists (id, name, items, schedules, version, created)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [pl.id, pl.name, JSON.stringify(pl.items || []), JSON.stringify(pl.schedules || []), pl.version, pl.created]);
  },
  
  async updatePlaylist(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    
    if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    if (updates.items !== undefined) { fields.push(`items = $${idx++}`); values.push(JSON.stringify(updates.items)); }
    if (updates.schedules !== undefined) { fields.push(`schedules = $${idx++}`); values.push(JSON.stringify(updates.schedules)); }
    if (updates.version !== undefined) { fields.push(`version = $${idx++}`); values.push(updates.version); }
    
    if (!fields.length) return;
    values.push(id);
    
    await pool.query(`UPDATE playlists SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  },
  
  async deletePlaylist(id) {
    await pool.query('DELETE FROM playlists WHERE id = $1', [id]);
  },
  
  // SCREENS
  async getAllScreens() {
    const { rows } = await pool.query('SELECT * FROM screens ORDER BY last_seen DESC');
    return rows.map(rowToScreen);
  },
  
  async getScreen(id) {
    const { rows } = await pool.query('SELECT * FROM screens WHERE id = $1', [id]);
    return rows[0] ? rowToScreen(rows[0]) : null;
  },
  
  async upsertScreen(s) {
    await pool.query(`
      INSERT INTO screens (id, name, ip, user_agent, last_seen, registered, playlist_id, rotation, fit_mode)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        ip = EXCLUDED.ip,
        user_agent = EXCLUDED.user_agent,
        last_seen = EXCLUDED.last_seen
    `, [s.id, s.name, s.ip, s.userAgent, s.lastSeen, s.registered, s.playlistId, s.rotation, s.fitMode]);
  },
  
  async updateScreen(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;
    
    if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    if (updates.ip !== undefined) { fields.push(`ip = $${idx++}`); values.push(updates.ip); }
    if (updates.lastSeen !== undefined) { fields.push(`last_seen = $${idx++}`); values.push(updates.lastSeen); }
    if (updates.playlistId !== undefined) { fields.push(`playlist_id = $${idx++}`); values.push(updates.playlistId); }
    if (updates.rotation !== undefined) { fields.push(`rotation = $${idx++}`); values.push(updates.rotation); }
    if (updates.fitMode !== undefined) { fields.push(`fit_mode = $${idx++}`); values.push(updates.fitMode); }
    
    if (!fields.length) return;
    values.push(id);
    
    await pool.query(`UPDATE screens SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  },
  
  async deleteScreen(id) {
    await pool.query('DELETE FROM screens WHERE id = $1', [id]);
  },
  
  // BULK
  async getFullState() {
    const [library, playlists, screens] = await Promise.all([
      this.getAllMedia(),
      this.getAllPlaylists(),
      this.getAllScreens()
    ]);
    
    // Convert arrays to keyed objects for compatibility
    const libraryObj = {};
    library.forEach(m => libraryObj[m.id] = m);
    
    const playlistsObj = {};
    playlists.forEach(p => playlistsObj[p.id] = p);
    
    const screensObj = {};
    screens.forEach(s => screensObj[s.id] = s);
    
    return {
      library: libraryObj,
      playlists: playlistsObj,
      screens: screensObj
    };
  }
};

// Row to object mappers
function rowToMedia(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    filename: row.filename,
    type: row.type,
    mimeType: row.mime_type,
    size: parseInt(row.size),
    width: row.width,
    height: row.height,
    uploaded: parseInt(row.uploaded)
  };
}

function rowToPlaylist(row) {
  return {
    id: row.id,
    name: row.name,
    items: row.items || [],
    schedules: row.schedules || [],
    version: row.version,
    created: parseInt(row.created)
  };
}

function rowToScreen(row) {
  return {
    id: row.id,
    name: row.name,
    ip: row.ip,
    userAgent: row.user_agent,
    lastSeen: parseInt(row.last_seen),
    registered: parseInt(row.registered),
    playlistId: row.playlist_id,
    rotation: row.rotation,
    fitMode: row.fit_mode
  };
}

// ============================================
// HELPERS
// ============================================
async function getImageDimensions(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch (e) {
    return { width: 0, height: 0 };
  }
}

async function buildPlaylistItems(items) {
  if (!items || !items.length) return [];
  
  const result = [];
  for (const item of items) {
    const media = await db.getMedia(item.mediaId);
    if (media) {
      result.push({
        id: media.id,
        name: media.name,
        url: media.url,
        type: media.type,
        size: media.size,
        width: media.width,
        height: media.height,
        duration: item.duration || (media.type === 'video' ? 10000 : 5000)
      });
    }
  }
  return result;
}

async function getScreenPlaylist(screen) {
  if (!screen.playlistId) return { items: [], source: 'none' };
  
  const playlist = await db.getPlaylist(screen.playlistId);
  if (!playlist) return { items: [], source: 'none' };
  
  const now = Date.now();
  
  if (playlist.schedules && playlist.schedules.length) {
    const activeSchedule = playlist.schedules.find(s => {
      if (!s.active) return false;
      const start = new Date(s.startDate).getTime();
      const end = new Date(s.endDate).getTime();
      return now >= start && now <= end;
    });
    
    if (activeSchedule) {
      return {
        items: await buildPlaylistItems(activeSchedule.items),
        source: 'schedule',
        scheduleName: activeSchedule.name,
        scheduleId: activeSchedule.id
      };
    }
  }
  
  return {
    items: await buildPlaylistItems(playlist.items),
    source: 'default',
    playlistName: playlist.name
  };
}

async function computePlaylistVersion(screen) {
  if (!screen.playlistId) return '0';
  const playlist = await db.getPlaylist(screen.playlistId);
  if (!playlist) return '0';
  
  const baseVersion = playlist.version || '0';
  const active = await getScreenPlaylist(screen);
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
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Screen-Id');
  // السماح للموقع يفتح في iframe من أي دومين (لـ OrderPro integration)
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  // Express by default doesn't set X-Frame-Options, but ensure it's not restricting
  res.removeHeader('X-Frame-Options');
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
// API: DISPLAY (Screen-side)
// ============================================

app.post('/api/register', async (req, res) => {
  const { rotation, fitMode } = req.body;
  const screenId = genScreenId(req);
  
  try {
    const existing = await db.getScreen(screenId);
    
    if (existing) {
      await db.updateScreen(screenId, {
        ip: req.ip,
        lastSeen: Date.now()
      });
      const updated = await db.getScreen(screenId);
      res.json({ screenId, config: updated });
    } else {
      const newScreen = {
        id: screenId,
        name: null,
        ip: req.ip,
        userAgent: req.headers['user-agent'] || '',
        lastSeen: Date.now(),
        registered: Date.now(),
        playlistId: null,
        rotation: rotation || 0,
        fitMode: fitMode || 'cover'
      };
      await db.upsertScreen(newScreen);
      res.json({ screenId, config: newScreen });
    }
  } catch (err) {
    console.error('Register failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screen/config', async (req, res) => {
  const screenId = req.query.screenId || genScreenId(req);
  const clientVersion = req.query.v;
  
  try {
    const screen = await db.getScreen(screenId);
    if (!screen) {
      return res.json({
        screenId,
        registered: false,
        serverTime: Date.now()
      });
    }
    
    // Update last seen
    await db.updateScreen(screenId, {
      lastSeen: Date.now(),
      ip: req.ip
    });
    
    const active = await getScreenPlaylist(screen);
    const effectiveVersion = await computePlaylistVersion(screen);
    
    let nextChange = null;
    if (screen.playlistId) {
      const playlist = await db.getPlaylist(screen.playlistId);
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
    
    const response = {
      screenId,
      registered: true,
      name: screen.name,
      rotation: screen.rotation,
      fitMode: screen.fitMode,
      version: effectiveVersion,
      serverTime: Date.now(),
      source: active.source,
      nextChange
    };
    
    if (active.scheduleName) response.scheduleName = active.scheduleName;
    
    if (clientVersion !== effectiveVersion) {
      response.playlist = active.items;
    }
    
    res.json(response);
  } catch (err) {
    console.error('Config failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/heartbeat', async (req, res) => {
  const screenId = req.headers['x-screen-id'] || genScreenId(req);
  
  try {
    await db.updateScreen(screenId, {
      lastSeen: Date.now(),
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ============================================
// API: ADMIN
// ============================================

app.get('/api/admin/state', async (req, res) => {
  try {
    const state = await db.getFullState();
    res.json(state);
  } catch (err) {
    console.error('State fetch failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// MEDIA LIBRARY
// ============================================
app.post('/api/admin/library/upload', upload.array('files'), async (req, res) => {
  try {
    const items = [];
    
    for (const f of req.files) {
      const id = 'media_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
      const isVideo = f.mimetype.startsWith('video/');
      
      let dimensions = { width: 0, height: 0 };
      if (!isVideo) {
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
      
      await db.insertMedia(media);
      items.push(media);
    }
    
    res.json({ items });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/library/:id', async (req, res) => {
  try {
    const media = await db.getMedia(req.params.id);
    if (!media) return res.status(404).json({ error: 'not found' });
    
    const { name } = req.body;
    if (name) await db.updateMedia(req.params.id, { name });
    
    const updated = await db.getMedia(req.params.id);
    res.json({ ok: true, media: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/library/:id', async (req, res) => {
  try {
    const media = await db.getMedia(req.params.id);
    if (!media) return res.status(404).json({ error: 'not found' });
    
    // Delete file
    try {
      const filePath = path.join(UPLOADS_DIR, media.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) { console.warn('Failed to delete file:', e.message); }
    
    // Remove from playlists (in their JSONB)
    const playlists = await db.getAllPlaylists();
    for (const pl of playlists) {
      let changed = false;
      const newItems = pl.items.filter(i => i.mediaId !== req.params.id);
      if (newItems.length !== pl.items.length) changed = true;
      
      let newSchedules = pl.schedules || [];
      newSchedules = newSchedules.map(sch => {
        const filteredItems = (sch.items || []).filter(i => i.mediaId !== req.params.id);
        if (filteredItems.length !== (sch.items || []).length) changed = true;
        return { ...sch, items: filteredItems };
      });
      
      if (changed) {
        await db.updatePlaylist(pl.id, {
          items: newItems,
          schedules: newSchedules,
          version: Date.now().toString()
        });
      }
    }
    
    await db.deleteMedia(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/library/:id/rotate', async (req, res) => {
  try {
    const media = await db.getMedia(req.params.id);
    if (!media) return res.status(404).json({ error: 'not found' });
    if (media.type !== 'image') return res.status(400).json({ error: 'only images can be rotated' });
    
    const { angle } = req.body;
    if (![90, 180, 270].includes(angle)) {
      return res.status(400).json({ error: 'invalid angle' });
    }
    
    const filePath = path.join(UPLOADS_DIR, media.filename);
    const tempPath = filePath + '.tmp';
    
    await sharp(filePath).rotate(angle).toFile(tempPath);
    fs.renameSync(tempPath, filePath);
    
    const newDimensions = await getImageDimensions(filePath);
    const baseUrl = media.url.split('?')[0];
    const newUrl = baseUrl + '?v=' + Date.now();
    
    await db.updateMedia(req.params.id, {
      width: newDimensions.width,
      height: newDimensions.height,
      url: newUrl
    });
    
    // Update playlists versions where this media is used
    const playlists = await db.getAllPlaylists();
    for (const pl of playlists) {
      const hasMedia = pl.items.some(i => i.mediaId === req.params.id) ||
        (pl.schedules || []).some(sch => (sch.items || []).some(i => i.mediaId === req.params.id));
      if (hasMedia) {
        await db.updatePlaylist(pl.id, { version: Date.now().toString() });
      }
    }
    
    const updated = await db.getMedia(req.params.id);
    res.json({ ok: true, media: updated });
  } catch (err) {
    console.error('Rotate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PLAYLISTS
// ============================================
app.post('/api/admin/playlists', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    
    const id = 'pl_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const playlist = {
      id,
      name: name.trim(),
      items: [],
      schedules: [],
      version: Date.now().toString(),
      created: Date.now()
    };
    
    await db.insertPlaylist(playlist);
    res.json({ ok: true, playlist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/playlists/:id', async (req, res) => {
  try {
    const pl = await db.getPlaylist(req.params.id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    
    const updates = { version: Date.now().toString() };
    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (Array.isArray(req.body.items)) {
      updates.items = req.body.items.map(i => ({
        mediaId: i.mediaId,
        duration: parseInt(i.duration) || 5000
      }));
    }
    
    await db.updatePlaylist(req.params.id, updates);
    const updated = await db.getPlaylist(req.params.id);
    res.json({ ok: true, playlist: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/playlists/:id', async (req, res) => {
  try {
    // Unassign from screens
    const screens = await db.getAllScreens();
    for (const s of screens) {
      if (s.playlistId === req.params.id) {
        await db.updateScreen(s.id, { playlistId: null });
      }
    }
    
    await db.deletePlaylist(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SCHEDULES
app.post('/api/admin/playlists/:id/schedules', async (req, res) => {
  try {
    const pl = await db.getPlaylist(req.params.id);
    if (!pl) return res.status(404).json({ error: 'playlist not found' });
    
    const { id, name, items, startDate, endDate, active } = req.body;
    
    if (!name || !startDate || !endDate || !Array.isArray(items)) {
      return res.status(400).json({ error: 'missing fields' });
    }
    
    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ error: 'end must be after start' });
    }
    
    const schedules = pl.schedules || [];
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
      const idx = schedules.findIndex(s => s.id === id);
      if (idx === -1) return res.status(404).json({ error: 'schedule not found' });
      schedules[idx] = { ...schedules[idx], ...scheduleData };
    } else {
      schedules.push({
        id: 'sch_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
        ...scheduleData,
        created: Date.now()
      });
    }
    
    await db.updatePlaylist(req.params.id, {
      schedules,
      version: Date.now().toString()
    });
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/playlists/:id/schedules/:scheduleId', async (req, res) => {
  try {
    const pl = await db.getPlaylist(req.params.id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    
    const schedules = (pl.schedules || []).filter(s => s.id !== req.params.scheduleId);
    await db.updatePlaylist(req.params.id, {
      schedules,
      version: Date.now().toString()
    });
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/playlists/:id/schedules/:scheduleId', async (req, res) => {
  try {
    const pl = await db.getPlaylist(req.params.id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    
    const schedules = pl.schedules || [];
    const sch = schedules.find(s => s.id === req.params.scheduleId);
    if (!sch) return res.status(404).json({ error: 'schedule not found' });
    
    if (req.body.active !== undefined) sch.active = !!req.body.active;
    
    await db.updatePlaylist(req.params.id, {
      schedules,
      version: Date.now().toString()
    });
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SCREENS
// ============================================
app.put('/api/admin/screens/:id', async (req, res) => {
  try {
    const screen = await db.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'not found' });
    
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.playlistId !== undefined) updates.playlistId = req.body.playlistId || null;
    if (req.body.rotation !== undefined) updates.rotation = parseInt(req.body.rotation);
    if (req.body.fitMode !== undefined) updates.fitMode = req.body.fitMode;
    
    await db.updateScreen(req.params.id, updates);
    const updated = await db.getScreen(req.params.id);
    res.json({ ok: true, screen: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/screens/:id', async (req, res) => {
  try {
    await db.deleteScreen(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// BACKUP
// ============================================
app.get('/api/admin/backup', async (req, res) => {
  try {
    const state = await db.getFullState();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="cafelax-backup-${Date.now()}.json"`);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => res.redirect('/admin.html'));
app.get('/health', async (req, res) => {
  try {
    const state = await db.getFullState();
    res.json({ 
      status: 'ok',
      time: Date.now(),
      database: 'connected',
      filesStorage: PERSISTENT_DIR,
      library: Object.keys(state.library).length,
      playlists: Object.keys(state.playlists).length,
      screens: Object.keys(state.screens).length
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ============================================
// STARTUP
// ============================================
async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`CAFELAX Signage v2.1 running on port ${PORT}`);
      console.log(`Database: PostgreSQL`);
      console.log(`Files: ${UPLOADS_DIR}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
