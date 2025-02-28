import { serve } from "bun";
import { startBot } from "./index"; // We'll need to export the bot startup function

const PORT = process.env.PORT || 3000;

// Start the bot
startBot().catch(err => console.error('Error starting bot:', err));

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
    
    // Not found
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server is running on port ${PORT}`);