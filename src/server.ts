import { serve } from "bun";
import { startBot } from "./index"; // We'll need to export the bot startup function
import syncFactionMembers, { shouldSync } from './services/memberSyncService';

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'your-secret-key'; // Add a secret key for API access

// Start the bot
startBot().catch(err => console.error('Error starting bot:', err));

// Track last check time for daily sync
let lastSyncCheck = new Date();

// Setup a 1-hour interval to check if sync is needed (at 1 AM UTC)
const ONE_HOUR = 60 * 60 * 1000; // 1 hour in milliseconds
setInterval(async () => {
  const now = new Date();
  
  // Check if it's around 1:00 AM UTC (between 1:00 and 1:59)
  if (now.getUTCHours() ===22) {
    // Check if we should run the sync
    const shouldRunSync = await shouldSync();
    
    if (shouldRunSync) {
      console.log('Starting scheduled faction members sync...');
      const result = await syncFactionMembers();
      console.log('Scheduled sync result:', result.message);
    } else {
      console.log('Sync already performed recently, skipping scheduled sync');
    }
  }
  
  // Update last check time
  lastSyncCheck = now;
}, ONE_HOUR);

// Create a simple server
const server = serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    
    // Simple homepage
    if (url.pathname === "/") {
      return new Response("FAC Discord Bot is running!");
    }
    
    // Health check endpoint for UptimeRobot
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Member sync endpoint (secured with API key)
    if (url.pathname === "/api/sync-members") {
      // Check API secret for security
      const authHeader = req.headers.get('authorization');
      const providedSecret = authHeader?.startsWith('Bearer ') 
        ? authHeader.substring(7) 
        : null;
        
      if (providedSecret !== API_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      syncFactionMembers()
      .then(result => {
        console.log('Member sync completed via API:', result.message);
      })
      .catch(error => {
        console.error('Member sync failed via API:', error);
      });

      
      // Handle the sync request
      return new Response(
        JSON.stringify({ message: "Starting member sync..." }),
        { 
          status: 202,
          headers: { "Content-Type": "application/json" }
        }
      );
      
      // Process sync in the background
    }
    
    // Status endpoint to check last sync time
    if (url.pathname === "/api/sync-status") {
      // Check API secret for security
      const authHeader = req.headers.get('authorization');
      const providedSecret = authHeader?.startsWith('Bearer ') 
        ? authHeader.substring(7) 
        : null;
        
      if (providedSecret !== API_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      return new Response(
        JSON.stringify({
          lastSyncCheck: lastSyncCheck.toISOString(),
          currentTime: new Date().toISOString()
        }),
        { 
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    
    // Not found
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server is running on port ${PORT}`);