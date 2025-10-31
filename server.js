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

// Mission tracking state
const operativeMissions = new Map(); // operativeId -> { completed: number, currentMission: object, name: string }
const missionHistory = []; // Array of all mission completions for analytics

// YouTube API Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Quota tracking
const MAX_SEARCH_QUOTA = 9000;

// Persistent quota tracking
const fs = require('fs');
const QUOTA_FILE = path.join(__dirname, 'quota-tracker.json');

// Load saved quota or initialize
let searchQuotaUsed = loadQuota();

function loadQuota() {
    try {
        if (fs.existsSync(QUOTA_FILE)) {
            const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
            
            // Check if we're in a new day (reset daily)
            const today = new Date().toDateString();
            if (data.date !== today) {
                console.log('📅 New day - resetting YouTube API quota');
                return 0; // Reset for new day
            }
            
            console.log(`📊 Loaded YouTube API quota: ${data.used}/${MAX_SEARCH_QUOTA} units used`);
            return data.used;
        }
    } catch (error) {
        console.error('Error loading quota:', error);
    }
    return 0;
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

// Save quota periodically and on server exit
setInterval(saveQuota, 30000); // Save every 30 seconds

process.on('SIGINT', () => {
    console.log('💾 Saving quota before shutdown...');
    saveQuota();
    process.exit();
});

// Validate API key
if (!YOUTUBE_API_KEY) {
  console.error('❌ ERROR: YOUTUBE_API_KEY is not set!');
  console.error('   Create a .env file with: YOUTUBE_API_KEY=your_key_here');
  process.exit(1);
}

// YouTube Search Endpoint with quota tracking
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  
  // Check quota first
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
        maxResults: 5, // Reduced from 10 to save quota
        key: YOUTUBE_API_KEY
      }
    });

    // Track quota: 100 units for search
    searchQuotaUsed += 100;
    saveQuota(); // ADD THIS LINE

    // Get video details to check embeddable status
    const videoIds = response.data.items.map(item => item.id.videoId).join(',');
    
    const detailsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,status',
        id: videoIds,
        key: YOUTUBE_API_KEY
      }
    });

    // Track quota: 1 unit per video (5 videos = 5 units)
    searchQuotaUsed += detailsResponse.data.items.length;
    saveQuota(); // ADD THIS LINE

    // Filter only embeddable videos and format results
    const videos = detailsResponse.data.items
      .filter(video => video.status.embeddable)
      .map(video => ({
        id: video.id,
        title: video.snippet.title,
        channel: video.snippet.channelTitle,
        thumbnail: video.snippet.thumbnails.default.url,
        embeddable: video.status.embeddable
      }));

    console.log(`🎵 Search for "${query}": Found ${videos.length} videos (Used ${100 + detailsResponse.data.items.length} units, Total: ${searchQuotaUsed}/${MAX_SEARCH_QUOTA})`);
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
        exceeded: searchQuotaUsed >= MAX_SEARCH_QUOTA,
        resetDate: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(), // Midnight tonight
        usagePercentage: Math.round((searchQuotaUsed / MAX_SEARCH_QUOTA) * 100)
    };
    res.json(quotaData);
});

;
// Proper YouTube API validation endpoint
app.post('/api/validate-video', async (req, res) => {
  const { youtubeUrl } = req.body;
  
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  // Check quota first
  if (searchQuotaUsed >= MAX_SEARCH_QUOTA) {
    return res.status(429).json({ 
      error: 'API quota exceeded for today',
      code: 'QUOTA_EXCEEDED'
    });
  }

  try {
    // Use YouTube Data API to get accurate embed status
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,status',
        id: videoId,
        key: YOUTUBE_API_KEY
      }
    });

    // Track quota: 1 unit for videos.list
    searchQuotaUsed += 1;
    saveQuota(); // ADD THIS LINE

    if (response.data.items.length === 0) {
      return res.status(400).json({ 
        error: 'Video not found',
        embeddable: false 
      });
    }

    const video = response.data.items[0];
    
    // Check if video is embeddable
    if (!video.status.embeddable) {
      return res.status(400).json({
        error: 'Video cannot be embedded on external websites',
        embeddable: false,
        details: 'Playback on other websites has been disabled by the video owner'
      });
    }

    // Check if video is available in your region/not blocked
    if (video.status.blockedInSomeCountries) {
      return res.status(400).json({
        error: 'Video not available in your region',
        embeddable: false,
        details: 'This video contains content that may not be available in your country'
      });
    }

    // Video should be good to go!
    res.json({
      success: true,
      videoId: videoId,
      title: video.snippet.title,
      channel: video.snippet.channelTitle,
      thumbnail: video.snippet.thumbnails.default.url,
      embeddable: true,
      duration: video.contentDetails?.duration || 'unknown',
      apiValidation: true
    });
    
  } catch (error) {
    console.error('YouTube API validation error:', error.response?.data || error.message);
    
    if (error.response?.status === 403) {
      // Quota exceeded or API key issues
      return res.status(429).json({ 
        error: 'YouTube API quota exceeded',
        code: 'QUOTA_EXCEEDED'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to validate video',
      details: error.message 
    });
  }
});

// see if video ended
app.get('/api/queue-status', (req, res) => {
    res.json({ queue: queue, currentSong: currentSong });
});

// Submit song request
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
    timestamp: new Date()
  };
  
  queue.push(queueItem);
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true, queuePosition: queue.length });
});

// Add song to top of queue
app.post('/api/add-to-top', async (req, res) => {
  const { singer, youtubeUrl } = req.body;
  
  if (!singer || !youtubeUrl) {
    return res.status(400).json({ error: 'Please provide both name and YouTube URL' });
  }
  
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }
  
  const songTitle = await getVideoTitle(videoId);
  
  const queueItem = {
    id: Date.now(),
    singer: singer.trim(),
    songTitle: songTitle,
    youtubeId: videoId,
    youtubeUrl: youtubeUrl,
    timestamp: new Date(),
    addedByAdmin: true
  };
  
  queue.unshift(queueItem);
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true, queuePosition: 1, songTitle });
});

// Move song up in queue
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

// Move song down in queue
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

// Remove specific song
app.post('/api/remove/:id', (req, res) => {
  queue = queue.filter(item => item.id != req.params.id);
  io.emit('queueUpdate', { queue, currentSong });
  res.json({ success: true });
});

// Admin controls
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

// MISSION TRACKING ENDPOINTS

// Get a random mission for an operative
app.get('/api/missions/get-mission', (req, res) => {
    const operativeId = req.query.operativeId;
    const completedMissions = req.query.completed ? JSON.parse(req.query.completed) : [];
    const completedTexts = req.query.completedTexts ? JSON.parse(req.query.completedTexts) : [];  // NEW
    
    // Filter out completed missions (using the same missions array from your HTML)
    const availableMissions = getAvailableMissions(completedMissions);
    
    // NEW: Also filter by completed texts
    const finalAvailableMissions = availableMissions.filter(mission => 
        !completedTexts.includes(mission.text)
    );
    
    if (finalAvailableMissions.length === 0) {
        return res.json({ available: false });
    }
    
    const randomMission = finalAvailableMissions[Math.floor(Math.random() * finalAvailableMissions.length)];
    
    // Track current mission
    if (!operativeMissions.has(operativeId)) {
        operativeMissions.set(operativeId, { 
            completed: 0, 
            currentMission: null, 
            name: 'Anonymous Operative',
            joinTime: new Date().toISOString(),
            completedTexts: []  // NEW
        });
    }
    operativeMissions.get(operativeId).currentMission = randomMission;
    
    res.json({ mission: randomMission });
});

// Complete a mission
app.post('/api/missions/complete', (req, res) => {
    const { operativeId, missionId, missionText } = req.body;  // NEW: missionText
    
    if (operativeMissions.has(operativeId)) {
        const operative = operativeMissions.get(operativeId);
        operative.completed += 1;
        operative.currentMission = null;
        operative.lastCompletion = new Date().toISOString();
        
        // NEW: Track completed mission texts on server too
        if (!operative.completedTexts) {
            operative.completedTexts = [];
        }
        if (missionText && !operative.completedTexts.includes(missionText)) {
            operative.completedTexts.push(missionText);
        }
        
        // Record completion history
        missionHistory.push({
            operativeId,
            missionId,
            missionText,  // NEW
            timestamp: new Date().toISOString(),
            operativeName: operative.name
        });
        
        // Broadcast leaderboard update
        io.emit('missionLeaderboardUpdate', getLeaderboard());
    }
    
    res.json({ 
        success: true, 
        completed: operativeMissions.get(operativeId)?.completed || 0 
    });
});

// Get mission leaderboard
app.get('/api/missions/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// Get all mission data for admin
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

// Register a new operative
app.post('/api/missions/register', (req, res) => {
  const { operativeId, name } = req.body;
  
  if (!operativeMissions.has(operativeId)) {
    operativeMissions.set(operativeId, { 
      completed: 0, 
      currentMission: null, 
      name: name || 'Anonymous Operative',
      joinTime: new Date().toISOString()
    });
  }
  
  res.json({ success: true });
});

// Helper function to get available missions
function getAvailableMissions(completedMissions) {
  // This should match your missions array from the HTML
  const allMissions = [
    { id: 1, text: "The Recruiter (Red): Secretly recruit people to the RED team. Teams go public at 10:30 PM.", category: "Social Alchemy" },
    { id: 2, text: "The Recruiter (Blue): Secretly recruit people to the BLUE team.", category: "Social Alchemy" },
    { id: 3, text: "The Winker's Curse: Wink until someone winks back, then pass the curse to them.", category: "Arcane Transmission" },
    { id: 4, text: "The Unlikely Fact: Tell an absurd 'fact.' When someone believes it, their mission is to spread it.", category: "Memetic Hazard" },
    { id: 5, text: "The Token of Power: Bestow a weird token on someone and tell them to protect and pass it on.", category: "Artifact Distribution" },
    { id: 6, text: "The Banana Obsession: Have five separate conversations. In each, say 'banana' at least three times naturally.", category: "Verbal Enchantment" },
    { id: 7, text: "The Tango Obsession: Have five separate conversations. In each, say 'tango' at least three times naturally.", category: "Verbal Enchantment" },
    { id: 8, text: "The Question Master: For 15 minutes, you can only speak in questions.", category: "Interrogation Protocol" },
    { id: 9, text: "The Echo: Whenever your target finishes a sentence, say '...exactly!'", category: "Parroting Ritual" },
    { id: 10, text: "The Whisperer: Whisper one fake secret to three different people.", category: "Covert Communication" },
    { id: 11, text: "The Complimenter: Give a genuine compliment to three people you don't know well.", category: "Social Engineering" },
    { id: 12, text: "The Contrarian: For 10 minutes, gently disagree with the first statement anyone makes.", category: "Contrarian Curse" },
    { id: 13, text: "The Translator: 'Translate' someone's conversation into a grand adventure.", category: "Linguistic Alchemy" },
    { id: 14, text: "The Debriefer: Find another agent and get them to confess their mission.", category: "Counter-Intelligence" },
    { id: 15, text: "The Conspiracy Theorist: Casually bring up a ridiculous conspiracy to a stranger.", category: "Disinformation" },
    { id: 16, text: "The Gossip: Start a harmless, positive rumor and see if it gets back to you.", category: "Information Spread" },
    { id: 17, text: "The Mirror: Have a 1-minute conversation where you copy someone's body language and repeat their last few words.", category: "Mimicry Magic" },
    { id: 18, text: "The Mayor: Learn the first names of 5 people you didn't know when you arrived.", category: "Social Cartography" },
    { id: 19, text: "The Ice Cube Challenge: See how many ice cubes you can fit in your mouth. You must refill the tray.", category: "Cryogenic Endurance" },
    { id: 20, text: "The Hydration Station: Drink from the sink for 10 seconds, then declare 'A fine vintage!'", category: "Hydration Ritual" },
    { id: 21, text: "The Hydration Station (Duplicate 1): Drink from the sink for 10 seconds, then declare 'A fine vintage!'", category: "Hydration Ritual" },
    { id: 22, text: "The Hydration Station (Duplicate 2): Drink from the sink for 10 seconds, then declare 'A fine vintage!'", category: "Hydration Ritual" },
    { id: 23, text: "The Hydration Station (Duplicate 3): Drink from the sink for 10 seconds, then declare 'A fine vintage!'", category: "Hydration Ritual" },
    { id: 24, text: "The Calisthenics Count: Do 20 jumping jacks outside, then report 'The blood is flowing.'", category: "Physical Exertion" },
    { id: 25, text: "The Shadow Boxer: Shadowbox an invisible opponent for 30 seconds.", category: "Combat Practice" },
    { id: 26, text: "The Elevated Limb: Keep one hand above your head for ten minutes.", category: "Physical Endurance" },
    { id: 27, text: "The Cursed T-Rex: Hold your arms like a T-Rex until you defeat someone at Rock-Paper-Scissors.", category: "Prehistoric Curse" },
    { id: 28, text: "The Blind Navigator: Walk with your eyes closed until someone hands you a drink.", category: "Sensory Deprivation" },
    { id: 29, text: "The Greeter: Stand by the door for 10 minutes and give a specific instruction to everyone who enters or leaves.", category: "Gatekeeping" },
    { id: 30, text: "The Champion: Defeat 5 different people at Rock-Paper-Scissors.", category: "Ritual Combat" },
    { id: 31, text: "The High-Fiver: Get a successful high-five from 10 different people.", category: "Physical Contact" },
    { id: 32, text: "The Floor is... Fine: For 2 minutes, move around by taking comically large, exaggerated steps.", category: "Locomotion Anomaly" },
    { id: 33, text: "The Serpent's Keeper: Carry the specific giant snake from the couch for 30 minutes, then return it.", category: "Familiar Handling" },
    { id: 34, text: "The Squadron Leader: Make 3 paper airplanes and get 3 different people to launch them at the same time.", category: "Aeronautical Command" },
    { id: 35, text: "The Basement Bar Champion: Go to the pull-up bar and do as many pull-ups as you can. If you can't do one, give it your absolute best honest attempt.", category: "Strength Test" },
    { id: 36, text: "The Dizzy Prophet: Spin around until dizzy, then deliver a prophecy to the first person you see.", category: "Divination Ritual" },
    { id: 37, text: "The Name-Tip-Toer: Whenever anyone says your name, rise onto your tip toes for 10 seconds. Curse lasts until you've done this for 5 different people.", category: "Name-based Compulsion" },
    { id: 38, text: "The Spell Caster: 'Cast a spell' on three people with a gesture and a magic word.", category: "Arcane Gestures" },
    { id: 39, text: "The Universal Remote: Use a small object as a 'remote' to subtly 'control' someone.", category: "Mind Influence" },
    { id: 40, text: "The Human Statue: Stand perfectly still against a wall for 5 minutes.", category: "Stillness Discipline" },
    { id: 41, text: "The Unexplained Face: Make a weird face for ten minutes and refuse to explain.", category: "Facial Anomaly" },
    { id: 42, text: "The Gifter: Gift a mundane object to someone as if it's a priceless treasure.", category: "Object Transmutation" },
    { id: 43, text: "The Tour Guide: Give a stranger a 60-second 'tour' of a very small, mundane area.", category: "Spatial Recontextualization" },
    { id: 44, text: "The Tech-Deck Pro: Do finger motions like you're fingerboarding and say things like 'I'm actually so sick at tech-deck' and 'Do you think it's hot when people are sick at tech-deck?'", category: "Skill Performance" },
    { id: 45, text: "The Renamer: For the rest of the night, refer to one common object by a wrong name. Complete after using the new name with 5 different people.", category: "Linguistic Subversion" },
    { id: 46, text: "The Vampire's Curse: You cannot pass through any doorframe unless someone on the other side verbally invites you to enter. Curse lasts until you've entered 5 different rooms.", category: "Threshold Compulsion" },
    { id: 47, text: "The Mummy's Binding: You cannot use your thumbs. Keep them tucked into your palms. Complete any three tasks without using them.", category: "Digital Limitation" },
    { id: 48, text: "The Gorgon's Gaze: You cannot make eye contact. Look at people's foreheads or mouths when speaking until you've spoken to 5 people.", category: "Visual Avoidance" },
    { id: 49, text: "The Confidant: Find an inanimate object and whisper a genuine secret to it. This is for you alone - no one else needs to notice.", category: "Confessional Ritual" },
    { id: 50, text: "The Quiet Moment: Find a place to sit and legitimately, earnestly meditate on peace and compassion for 2 full minutes.", category: "Internal Focus" },
    { id: 51, text: "The Catfish: Talk about your 'cat,' then show a picture from a Google image search.", category: "Digital Deception" },
    { id: 52, text: "The Catfish (Duplicate): Talk about your 'cat,' then show a picture from a Google image search.", category: "Digital Deception" },
    { id: 53, text: "The Catfish (Duplicate 2): Talk about your 'cat,' then show a picture from a Google image search.", category: "Digital Deception" },
    { id: 54, text: "The Paparazzo: Take a 'candid' photo of 5 different people without them noticing.", category: "Covert Photography" },
    { id: 55, text: "The Director: Gather 3 strangers, stage a famous scene, and take a photo.", category: "Scene Direction" },
    { id: 56, text: "The Food Critic: Photograph a gross food/drink combo and get a 'professional opinion.'", category: "Gastronomic Documentation" },
    { id: 57, text: "The Archivist: Get a photo of yourself with 3 people you've never met.", category: "Social Documentation" },
    { id: 58, text: "The Witness: Take a blurry, 'Bigfoot-style' photo of someone doing their secret mission.", category: "Cryptid Documentation" },
    { id: 59, text: "The Documentarian: Take 25 different photos throughout this party to create a visual record of the night.", category: "Event Documentation" },
    { id: 60, text: "The Saboteur: Find the person doing The Banana Obsession mission and subtly prevent them from completing it without revealing you're sabotaging them.", category: "Counter-Operation" },
    { id: 61, text: "The Guardian: Protect a specific object for 30 minutes.", category: "Asset Protection" },
    { id: 62, text: "The Investigator: Learn a stranger's first pet's name and report it to two others.", category: "Information Gathering" },
    { id: 63, text: "The Birthday Anarchist: Start and lead a full 'Happy Birthday' song for someone whose birthday it absolutely is not. Get at least 5 people to join in.", category: "Temporal Subversion" },
    { id: 64, text: "The Nouveau Riche / The Insider: For the next 5 people you talk to, casually mention either 'I have a lot of money' or 'I have high-up contacts in the federal government.'", category: "Status Projection" },
    { id: 65, text: "The Synchronicity Seeker: Successfully say the exact same word at the exact same time as someone else, completely unplanned, three separate times.", category: "Mental Synchronization" },
    { id: 66, text: "The Family Ambassador: Call a family member or close friend and have them talk to a stranger at this party for at least one minute.", category: "Social Bridging" },
    { id: 67, text: "The Hydro Hustler: Fill an empty alcoholic beverage container with water and chug the entire thing publicly in one go.", category: "Public Consumption" },
    { id: 68, text: "The Prank Caller: Step outside and make a prank call to a friend or family member, maintaining the prank for at least 60 seconds.", category: "Telephonic Deception" },
    { id: 69, text: "The Hawk Tuah Evangelist: Text someone else at this party a link to a 'hawk tuah' video with the message: 'I still think this is so funny.'", category: "Memetic Transmission" },
    { id: 70, text: "The Procrastination Buster: Make a genuine commitment to do one real-life task you've been procrastinating on. Set a daily alarm in your phone right now with a reminder to work on it.", category: "Self-Improvement" },
    { id: 71, text: "The Whistling Mariner: Let out three long, loud, piercing whistles—as loud and as long as you can sustain each one. Space them out by at least one minute.", category: "Auditory Disturbance" },
    { id: 72, text: "The Golden Frog: Somewhere in this house, there is a hidden golden frog. Find it and show it to either wizard to claim your prize!", category: "Treasure Hunt" },
    { id: 73, text: "The Challenger: Challenge someone to an arm wrestling match and either win or last for at least 30 seconds without being defeated.", category: "Physical Challenge" },
    { id: 74, text: "The Secret Admirer: Leave three anonymous, genuine compliments written on sticky notes in hidden places for three different people to find.", category: "Anonymous Affirmation" },
    { id: 75, text: "The Cartographer: Draw a simple 'treasure map' of the house on a napkin, hide a small object, and give the map to a stranger to find it.", category: "Cartographic Deception" },
    { id: 76, text: "The Translator: You can only speak in a fictional language of gibberish. Use gestures and expressive sounds to communicate until you successfully get someone to bring you a drink.", category: "Linguistic Barrier" },
    { id: 77, text: "The Fact Checker: Listen to someone make any statement, then immediately pull out your phone and say 'Let me fact-check that.' After a dramatic pause, declare 'The experts confirm it' regardless of what you find.", category: "Information Verification" },
    { id: 78, text: "The Interpreter: Find two people having a conversation and stand near them, providing 'translations' of what they're saying to anyone who will listen.", category: "Conversational Mediation" }
  ];
  
  return allMissions.filter(mission => !completedMissions.includes(mission.id));
}

// Helper function to get leaderboard
function getLeaderboard() {
  return Array.from(operativeMissions.entries())
    .map(([id, data]) => ({
      operativeId: id,
      name: data.name,
      completed: data.completed,
      currentMission: data.currentMission,
      joinTime: data.joinTime
    }))
    .sort((a, b) => b.completed - a.completed);
}

// Helper functions for YouTube
function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

async function getVideoTitle(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    const data = await response.json();
    return data.title;
  } catch (error) {
    return `Karaoke Song (${videoId})`;
  }
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

// Add mission briefing and missions routes
app.get('/briefing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'briefing.html'));
});

app.get('/missions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'missions.html'));
});

// Socket.io for real-time updates
io.on('connection', (socket) => {
  socket.emit('queueUpdate', { queue, currentSong });
  socket.emit('missionLeaderboardUpdate', getLeaderboard());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎤 Karaoke Party Server running on port ${PORT}`);
  console.log(`📱 Guest sign-up: http://localhost:${PORT}`);
  console.log(`🎮 Admin control: http://localhost:${PORT}/admin`);
  console.log(`📺 Player screen: http://localhost:${PORT}/player`);
  console.log(`🎭 Mission briefing: http://localhost:${PORT}/briefing`);
  console.log(`🔮 Mission control: http://localhost:${PORT}/missions`);
  console.log(`✅ YouTube API: Connected and ready`);
  console.log(`✅ Quota tracking: Active (${MAX_SEARCH_QUOTA} units available)`);
  console.log(`✅ Mission tracking: Active with ${getAvailableMissions([]).length} missions`);
  
  const ip = require('address').ip();
  console.log('\n📲 QR Code for guests:');
  qrcode.generate(`http://${ip}:${PORT}`, { small: true });
});