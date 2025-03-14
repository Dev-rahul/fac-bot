import { Hono } from 'hono';
import { serve } from "bun";
import { startBot } from "./index";
import syncFactionMembers, { shouldSync } from './services/memberSyncService';
import { fetchFactionFunds } from './services/factionFundsService';
import { supabase } from './database/supabaseClient';


const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'your-secret-key';

// Start the bot
startBot().catch(err => console.error('Error starting bot:', err));

// Track last check time for daily sync
let lastSyncCheck = new Date();

// Setup scheduler for 10:00 PM UTC check
const ONE_HOUR = 60 * 60 * 1000;
const SNAPSHOT_HOUR = 12;
setInterval(async () => {
  const now = new Date();
  
  if (now.getUTCHours() === 22) {
    const shouldRunSync = await shouldSync();
    
    if (shouldRunSync) {
      console.log('Starting scheduled faction members sync...');
      const result = await syncFactionMembers();
      console.log('Scheduled sync result:', result.message);
    } else {
      console.log('Sync already performed recently, skipping scheduled sync');
    }
  }

   // Run funds snapshot at 12:00 UTC
   if (now.getUTCHours() === SNAPSHOT_HOUR && now.getUTCMinutes() < 5) {
    console.log('Taking scheduled faction funds snapshot...');
    const snapshot = await fetchFactionFunds();
    
    if (snapshot) {
      console.log(`Funds snapshot saved: $${snapshot.faction_money.toLocaleString()} in faction funds`);
    } else {
      console.log('Failed to save funds snapshot');
    }
  }
  
  lastSyncCheck = now;
}, ONE_HOUR);

// Create Hono app
const app = new Hono();

// Middleware for protected routes
const authMiddleware = async (c, next) => {
  // Check token in header or query parameter
  const headerAuth = c.req.header('Authorization');
  const headerToken = headerAuth?.startsWith('Bearer ') ? headerAuth.substring(7) : null;
  const queryToken = c.req.query('token');
  
  if (headerToken !== API_SECRET && queryToken !== API_SECRET) {
    return c.text('Unauthorized', 401);
  }
  
  await next();
};

// Public routes
app.get('/', (c) => c.text('FAC Discord Bot is running!'));
app.get('/health', (c) => c.text('OK'));

// Create a group for protected API routes
// FIXED: Create a new Hono instance for the API routes
const api = new Hono();

// Member sync endpoint
api.get('/sync-members', async (c) => {
  // Start sync process in background
  syncFactionMembers()
    .then(result => {
      console.log('Member sync completed via API:', result.message);
    })
    .catch(error => {
      console.error('Member sync failed via API:', error);
    });
    
  return c.json({ message: "Starting member sync..." }, 202);
});

// Status endpoint
api.get('/sync-status', async (c) => {
  return c.json({
    lastSyncCheck: lastSyncCheck.toISOString(),
    currentTime: new Date().toISOString()
  });
});

// Add this to your API routes in server.ts
api.get('/sync-funds', async (c) => {
  try {
    // Check if a snapshot was taken recently
    const shouldRunSync = await fetchFactionFunds();
    
    if (!shouldRunSync) {
      return c.json({ 
        success: false, 
        message: 'Funds sync already performed recently' 
      }, 200);
    }
    
    console.log('Starting faction funds sync via API...');
  
    
    return c.json({
      success: true,
      message: 'Funds sync completed successfully',
    }, 200);
    
  } catch (error) {
    console.error('Error in funds sync API:', error);
    return c.json({
      success: false,
      message: 'Failed to sync funds data',
      error: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});

// Enhanced endpoints with Hono capabilities
// Get faction members statistics
api.get('/members/stats', async (c) => {
  try {
    const { data, error } = await supabase
      .from('faction_members')
      .select('position, level');
      
    if (error) throw error;
    
    // Calculate statistics
    const positionCounts = {};
    const levelStats = { min: Infinity, max: 0, avg: 0, total: 0, count: 0 };
    
    data.forEach(member => {
      // Count positions
      positionCounts[member.position] = (positionCounts[member.position] || 0) + 1;
      
      // Track level stats if level is available
      if (member.level) {
        levelStats.min = Math.min(levelStats.min, member.level);
        levelStats.max = Math.max(levelStats.max, member.level);
        levelStats.total += member.level;
        levelStats.count++;
      }
    });
    
    levelStats.avg = levelStats.count > 0 ? Math.round(levelStats.total / levelStats.count) : 0;
    
    return c.json({
      positions: positionCounts,
      levels: levelStats,
      total: data.length,
      lastUpdated: lastSyncCheck.toISOString()
    });
  } catch (error) {
    console.error('Error getting member stats:', error);
    return c.json({ error: 'Failed to fetch member statistics' }, 500);
  }
});

// Apply authentication to all API routes and mount them at /api
// FIXED: Use a different approach to mount the API routes
app.use('/api/*', authMiddleware);
app.route('/api', api);

// Serve the app
serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`Server is running with Hono on port ${PORT}`);