require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));
app.use(express.json());

let queue = [];
let currentSong = null;

// Mission tracking state - SIMPLIFIED
const operativeMissions = new Map(); // operativeId -> { completed: number, name: string, joinTime: string }
const missionHistory = [];

// YouTube API Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Quota tracking
const MAX_SEARCH_QUOTA = 9000;
const fs = require('fs');
const QUOTA_FILE = path.join(__dirname, 'quota-tracker.json');

let searchQuotaUsed = 0;

// Load saved quota
try {
  if (fs.existsSync(QUOTA_FILE)) {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    const today = new Date().toDateString();
    if (data.date === today) {
      searchQuotaUsed = data.used;
      console.log(`📊 Loaded YouTube API quota: ${searchQuotaUsed}/${MAX_SEARCH_QUOTA} units used`);
    }
  }
} catch (error) {
  console.error('Error loading quota:', error);
}

function saveQuota() {
  try {
    const data = {
      used: searchQuotaUsed,
      date: new Date().toDateString(),
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving quota:', error);
  }
}

// YouTube Search Endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  
  if (searchQuotaUsed >= MAX_SEARCH_QUOTA) {
    return res.status(429).json({ 
      error: 'Search quota exceeded for today',
      code: 'QUOTA_EXCEEDED'
    });
  }

  if (!query) {
    return res.json([]);
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query + ' karaoke',
        type: 'video',
        maxResults: 5,
        key: YOUTUBE_API_KEY
      }
    });

    searchQuotaUsed += 100;

    const videoIds = response.data.items.map(item => item.id.videoId).join(',');
    
    const detailsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,status',
        id: videoIds,
        key: YOUTUBE_API_KEY
      }
    });

    searchQuotaUsed += detailsResponse.data.items.length;
    saveQuota();

    const videos = detailsResponse.data.items
      .filter(video => video.status.embeddable)
      .map(video => ({
        id: video.id,
        title: video.snippet.title,
        channel: video.snippet.channelTitle,
        thumbnail: video.snippet.thumbnails.default.url,
        embeddable: video.status.embeddable
      }));

    console.log(`🎵 Search for "${query}": Found ${videos.length} videos`);
    res.json(videos);
  } catch (error) {
    console.error('YouTube API error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Quota status endpoint
app.get('/api/quota-status', (req, res) => {
    const quotaData = {
        used: searchQuotaUsed,
        max: MAX_SEARCH_QUOTA,
        remaining: MAX_SEARCH_QUOTA - searchQuotaUsed,
        exceeded: searchQuotaUsed >= MAX_SEARCH_QUOTA
    };
    res.json(quotaData);
});

// Extract YouTube ID
function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Queue management endpoints
app.get('/api/queue-status', (req, res) => {
    res.json({ queue: queue, currentSong: currentSong });
});

app.post('/api/request', async (req, res) => {
  const { singer, videoId, songTitle } = req.body;
  
  if (!singer || !videoId) {
    return res.status(400).json({ error: 'Please provide singer and select a song' });
  }
  
  const queueItem = {
    id: Date.now(),
    singer: singer.trim(),
    songTitle: songTitle || `YouTube Video (${videoId})`,
    youtubeId: videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
    timestamp: new Date(),
    playbackMethod: 'embed'
  };
  
  queue.push(queueItem);
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true, queuePosition: queue.length });
});

// FIXED: Removed duplicate 'a' and removed duplicate code block
app.post('/api/validate-and-queue', async (req, res) => {
  const { singer, youtubeUrl } = req.body;
  
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    let embeddable = true;
    let songTitle = `YouTube Video (${videoId})`;

    // YouTube embeddability check
    if (searchQuotaUsed < MAX_SEARCH_QUOTA) {
      try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: {
            part: 'snippet,status',
            id: videoId,
            key: YOUTUBE_API_KEY
          }
        });

        if (response.data.items.length > 0) {
          const video = response.data.items[0];
          embeddable = video.status.embeddable && !video.status.blockedInSomeCountries;
          songTitle = video.snippet.title;
          searchQuotaUsed += 1;
          saveQuota(); // FIXED: Added missing saveQuota()
        }
      } catch (error) {
        console.log('API check failed, assuming embeddable');
      }
    }

    const queueItem = {
      id: Date.now(),
      singer: singer.trim(),
      songTitle: songTitle,
      youtubeId: videoId,
      youtubeUrl: youtubeUrl,
      timestamp: new Date(),
      playbackMethod: embeddable ? 'embed' : 'browser'
    };
    
    queue.push(queueItem);
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ 
      success: true, 
      queuePosition: queue.length,
      playbackMethod: queueItem.playbackMethod
    });
    
  } catch (error) {
    console.error('Queue error:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

app.post('/api/admin-add-to-top', async (req, res) => {
  const { singer, youtubeUrl } = req.body;
  
  if (!singer || !youtubeUrl) {
    return res.status(400).json({ error: 'Please provide both name and YouTube URL' });
  }
  
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    let embeddable = true;
    let songTitle = `YouTube Video (${videoId})`;

    if (searchQuotaUsed < MAX_SEARCH_QUOTA) {
      try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: {
            part: 'status',
            id: videoId,
            key: YOUTUBE_API_KEY
          }
        });

        if (response.data.items.length > 0) {
          const video = response.data.items[0];
          embeddable = video.status.embeddable && !video.status.blockedInSomeCountries;
          searchQuotaUsed += 1;
          saveQuota(); // FIXED: Added missing saveQuota()
        }
      } catch (error) {
        console.log('API embed check failed, assuming embeddable');
      }
    }

    const queueItem = {
      id: Date.now(),
      singer: singer.trim(),
      songTitle: songTitle,
      youtubeId: videoId,
      youtubeUrl: youtubeUrl,
      timestamp: new Date(),
      addedByAdmin: true,
      playbackMethod: embeddable ? 'embed' : 'browser'
    };
    
    queue.unshift(queueItem);
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ 
      success: true, 
      queuePosition: 1, 
      songTitle,
      playbackMethod: queueItem.playbackMethod 
    });
    
  } catch (error) {
    console.error('Admin add error:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

// Queue control endpoints
app.post('/api/move-up/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = queue.findIndex(item => item.id === id);
  
  if (index > 0) {
    [queue[index], queue[index - 1]] = [queue[index - 1], queue[index]];
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Already at top' });
  }
});

app.post('/api/move-down/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = queue.findIndex(item => item.id === id);
  
  if (index >= 0 && index < queue.length - 1) {
    [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Already at bottom' });
  }
});

app.post('/api/remove/:id', (req, res) => {
  queue = queue.filter(item => item.id != req.params.id);
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true });
});

app.post('/api/next', (req, res) => {
  if (queue.length > 0) {
    currentSong = queue.shift();
    io.emit('songStarted', currentSong);
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ success: true, song: currentSong });
  } else {
    currentSong = null;
    io.emit('queueUpdate', { queue, currentSong });
    res.json({ success: false, message: 'Queue is empty' });
  }
});

app.post('/api/clear', (req, res) => {
  queue = [];
  currentSong = null;
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true });
});

// MISSION SYSTEM ENDPOINTS - SIMPLIFIED

// Register operative
app.post('/api/missions/register', (req, res) => {
  const { operativeId, name } = req.body;
  
  console.log('🔮 Registering operative:', { operativeId, name });
  
  if (!operativeMissions.has(operativeId)) {
    operativeMissions.set(operativeId, { 
      completed: 0, 
      name: name || 'Unknown Operative',
      joinTime: new Date().toISOString()
    });
    console.log(`🆕 New operative: ${name}`);
  } else {
    // Update name if provided
    const operative = operativeMissions.get(operativeId);
    if (name && name !== operative.name) {
      operative.name = name;
      console.log(`✏️ Updated operative name: ${operative.name}`);
    }
  }
  
  res.json({ success: true });
});

// Complete mission
app.post('/api/missions/complete', (req, res) => {
  const { operativeId } = req.body;
  
  console.log('🎯 Mission completion for:', operativeId);
  
  if (!operativeId) {
    return res.status(400).json({ error: 'Missing operative ID' });
  }

  if (!operativeMissions.has(operativeId)) {
    return res.status(404).json({ error: 'Operative not found' });
  }

  const operative = operativeMissions.get(operativeId);
  operative.completed += 1;
  operative.lastCompletion = new Date().toISOString();
  
  // Record history
  missionHistory.push({
    operativeId,
    operativeName: operative.name,
    timestamp: new Date().toISOString()
  });

  console.log(`✅ ${operative.name} completed mission. Total: ${operative.completed}`);
  
  // Broadcast to ALL connected clients
  const leaderboard = getLeaderboard();
  io.emit('missionLeaderboardUpdate', leaderboard);
  
  res.json({ 
    success: true, 
    completed: operative.completed,
    leaderboard: leaderboard
  });
});

// Get leaderboard
app.get('/api/missions/leaderboard', (req, res) => {
  const leaderboard = getLeaderboard();
  res.json(leaderboard);
});

// Get admin data
app.get('/api/missions/admin-data', (req, res) => {
  const adminData = {
    operatives: Array.from(operativeMissions.entries()).map(([id, data]) => ({
      id,
      ...data
    })),
    history: missionHistory,
    totalCompletions: missionHistory.length,
    totalOperatives: operativeMissions.size
  };
  
  res.json(adminData);
});

// Helper function to get leaderboard
function getLeaderboard() {
  return Array.from(operativeMissions.entries())
    .map(([id, data]) => ({
      operativeId: id,
      name: data.name,
      completed: data.completed,
      joinTime: data.joinTime
    }))
    .sort((a, b) => b.completed - a.completed);
}

// ROUTES
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/briefing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'briefing.html'));
});

app.get('/missions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'missions.html'));
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('🔌 Client connected');
  socket.emit('queueUpdate', { queue, currentSong });
  socket.emit('missionLeaderboardUpdate', getLeaderboard());
});

// Save quota periodically
setInterval(saveQuota, 30000);

process.on('SIGINT', () => {
  console.log('💾 Saving quota before shutdown...');
  saveQuota();
  process.exit();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎤 Karaoke Party Server running on port ${PORT}`);
  console.log(`📱 Guest sign-up: http://localhost:${PORT}`);
  console.log(`🎮 Admin control: http://localhost:${PORT}/admin`);
  console.log(`📺 Player screen: http://localhost:${PORT}/player`);
  console.log(`🎭 Mission briefing: http://localhost:${PORT}/briefing`);
  console.log(`🔮 Mission control: http://localhost:${PORT}/missions`);
  console.log(`✅ Mission system: Active with ${operativeMissions.size} operatives`);
  
  const ip = require('address').ip();
  console.log('\n📲 QR Code for guests:');
  qrcode.generate(`http://${ip}:${PORT}`, { small: true });
});