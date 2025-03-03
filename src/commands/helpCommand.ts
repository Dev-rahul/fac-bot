import { Message, EmbedBuilder } from "discord.js";

/**
 * Generates help information for all available bot commands
 */
export async function handleHelpCommand(message: Message, args: string[]): Promise<void> {
  try {
    // Check if asking for a specific command
    if (args.length > 0) {
      const commandName = args[0].toLowerCase();
      await showSpecificCommandHelp(message, commandName);
      return;
    }
    
    // General help overview
    const embed = new EmbedBuilder()
      .setTitle("📋 Fatality Bot Command Reference")
      .setColor("#0099FF")
      .setDescription("Here are all the commands available in this bot:")
      .addFields(
        {
          name: "🔍 Monitoring Commands",
          value: 
            "`!monitor start [maxTime] [interval] [factionId]` - Start target monitoring\n" +
            "`!monitor stop` - Stop monitoring\n" +
            "`!monitor status` - Show monitoring status\n" +
            "`!monitor clear` - Clear all messages in channel\n" +
            "`!monitor dibs` - Show current target claims"
        },
        {
          name: "📊 War Report Commands",
          value: 
            "`!warreport [attach CSV]` - Process a CSV war report for payment tracking\n" +
            "`!warreport generate [warId]` - Generate a war report from API data\n" +
            "`!warreport history [warId]` - View historical war reports\n" +
            "`!warreport verify <memberId>` - Check payment history for a member\n" +
            "`!warreport verifyall` - Check all recent payments for duplicates"
        },
        {
          name: "ℹ️ Help Commands",
          value: 
            "`!help` - Show this help message\n" +
            "`!help <command>` - Get detailed help for a specific command"
        }
      )
      .setFooter({ text: "Use !help <command> for more details about a specific command" });
      
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error handling help command:", error);
    await message.reply("An error occurred while generating help information.");
  }
}

/**
 * Show detailed help for a specific command
 */
async function showSpecificCommandHelp(message: Message, commandName: string): Promise<void> {
  const helpData: Record<string, { title: string, description: string, usage: string, examples: string[] }> = {
    "monitor": {
      title: "Monitor Command",
      description: "Tracks opponent faction members for attack opportunities. Shows members who will be out of the hospital soon or are currently available to attack.",
      usage: "!monitor <action> [options]",
      examples: [
        "!monitor start 5 20 - Start monitoring with 5 min hospital time and 20sec interval",
        "!monitor start 10 30 12345 - Monitor faction ID 12345 with 10 min time and 30sec interval",
        "!monitor stop - Stop monitoring",
        "!monitor status - Check monitoring status",
        "!monitor dibs - See claimed targets"
      ]
    },
    "warreport": {
      title: "War Report Commands",
      description: "Generate, track, and manage faction war reports. Includes payment tracking and verification.",
      usage: "!warreport <action> [options]",
      examples: [
        "!warreport - Upload a CSV file to process it",
        "!warreport generate - Generate report for most recent war",
        "!warreport generate 12345 - Generate report for war ID 12345",
        "!warreport history - View list of stored war reports",
        "!warreport history 12345 - View specific historical report",
        "!warreport verify 2287711 - Check payment history for member ID"
      ]
    },
    "generate": {
      title: "War Report Generate Command",
      description: "Generates a comprehensive war report from Torn API data, showing member contributions, respect gained, and other statistics.",
      usage: "!warreport generate [warId]",
      examples: [
        "!warreport generate - Generate report for most recent war",
        "!warreport generate 12345 - Generate report for specific war ID 12345"
      ]
    },
    "history": {
      title: "War Report History Command",
      description: "View historical war reports stored in the database without regenerating them.",
      usage: "!warreport history [warId]",
      examples: [
        "!warreport history - List available historical reports",
        "!warreport history 12345 - View specific historical report by war ID"
      ]
    },
    "verify": {
      title: "Payment Verification Command",
      description: "Verify payment status for specific members or check for duplicate payments.",
      usage: "!warreport verify <memberId> or !warreport verifyall",
      examples: [
        "!warreport verify 2287711 - Check payment history for specific member",
        "!warreport verifyall - Check for duplicate payments across all members"
      ]
    },
    "help": {
      title: "Help Command",
      description: "Shows information about available commands.",
      usage: "!help [command]",
      examples: [
        "!help - Show all available commands",
        "!help monitor - Show detailed help for monitor command",
        "!help warreport - Show detailed help for war report commands"
      ]
    }
  };

  // Handle command aliases
  const commandMap: Record<string, string> = {
    "gen": "generate",
    "hist": "history",
    "start": "monitor",
    "stop": "monitor",
    "status": "monitor",
    "dibs": "monitor",
    "clear": "monitor"
  };

  // Get the command data
  const commandKey = commandMap[commandName] || commandName;
  const commandData = helpData[commandKey];

  if (!commandData) {
    await message.reply(`No help available for command: ${commandName}. Use \`!help\` to see all commands.`);
    return;
  }

  // Create and send detailed help embed
  const embed = new EmbedBuilder()
    .setTitle(`Help: ${commandData.title}`)
    .setColor("#0099FF")
    .setDescription(commandData.description)
    .addFields(
      { name: "Usage", value: `\`${commandData.usage}\`` },
      { name: "Examples", value: commandData.examples.map(ex => `• \`${ex}\``).join('\n') }
    );

  await message.reply({ embeds: [embed] });
}