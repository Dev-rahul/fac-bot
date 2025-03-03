import { handleHelpCommand, handleCommandsCommand } from './helpCommand';
import { Message } from 'discord.js';

// Command handler for the bot
export async function handleCommand(message: Message): Promise<void> {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Check if the message starts with the command prefix
  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;
  
  // Parse the command and arguments
  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  
  if (!command) return;
  
  // Handle different commands
  switch (command) {
    case 'help':
      await handleHelpCommand(message, args);
      break;
      
    case 'commands':
      await handleCommandsCommand(message);
      break;
      
    // Add other command handlers here
      
    default:
      // Unknown command - do nothing or reply with help suggestion
      break;
  }
}