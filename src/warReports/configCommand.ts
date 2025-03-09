import { Message, EmbedBuilder } from 'discord.js';
import { 
  getAllPaymentConfigs, 
  setConfigValue, 
  resetConfigToDefault, 
  resetAllConfigsToDefaults 
} from '../database/paymentConfigRepository';

/**
 * Handle configuration commands for payment settings
 */
export async function handleConfigCommand(message: Message, args: string[]): Promise<void> {
  try {
    // Check if user has permission (should be admin/officer only)
    if (!hasPermission(message)) {
      await message.reply("You don't have permission to manage payment configurations.");
      return;
    }

    // No arguments - display current config
    if (args.length === 0) {
      await showCurrentConfig(message);
      return;
    }

    const subCommand = args[0].toLowerCase();

    switch (subCommand) {
      case 'set':
        // Format: !warreport config set <key> <value>
        if (args.length < 3) {
          await message.reply("Usage: `!warreport config set <key> <value> [description]`");
          return;
        }
        
        const key = args[1].toLowerCase();
        const value = parseFloat(args[2]);
        
        if (isNaN(value)) {
          await message.reply("Value must be a number.");
          return;
        }
        
        // Validate specific values
        if (key === 'payout_percentage' && (value < 0 || value > 100)) {
          await message.reply("Payout percentage must be between 0 and 100.");
          return;
        }
        
        const description = args.length > 3 ? args.slice(3).join(' ') : undefined;
        const success = await setConfigValue(key, value, description);
        
        if (success) {
          await message.reply(`✅ Configuration '${key}' set to ${value}`);
        } else {
          await message.reply(`❌ Failed to set configuration '${key}'`);
        }
        break;
        
      case 'reset':
        // Format: !warreport config reset [key]
        if (args.length === 1) {
          const success = await resetAllConfigsToDefaults();
          if (success) {
            await message.reply("✅ All configurations reset to default values");
          } else {
            await message.reply("❌ Failed to reset configurations");
          }
        } else {
          const key = args[1].toLowerCase();
          const success = await resetConfigToDefault(key);
          if (success) {
            await message.reply(`✅ Configuration '${key}' reset to default value`);
          } else {
            await message.reply(`❌ Failed to reset configuration '${key}'`);
          }
        }
        break;
        
      default:
        await message.reply(
          "Available config commands:\n" +
          "`!warreport config` - Display current configuration\n" +
          "`!warreport config set <key> <value> [description]` - Set a configuration value\n" +
          "`!warreport config reset [key]` - Reset configurations to defaults"
        );
    }
  } catch (error) {
    console.error("Error handling config command:", error);
    await message.reply("An error occurred while processing the configuration command.");
  }
}

/**
 * Check if user has permission to manage configurations
 */
function hasPermission(message: Message): boolean {
  // Check if user has admin/manage server permissions
  if (message.member?.permissions.has("Administrator") || 
      message.member?.permissions.has("ManageGuild")) {
    return true;
  }
  
  // Check if user has specific role(s)
  // You can replace these role IDs with actual roles for your server
  const officerRoleIds = ['1000000000000000000']; // Replace with actual officer role IDs
  
  return message.member?.roles.cache.some(role => officerRoleIds.includes(role.id)) || false;
}

/**
 * Show current payment configuration
 */
async function showCurrentConfig(message: Message): Promise<void> {
  const configs = await getAllPaymentConfigs();
  
  if (!configs || configs.length === 0) {
    await message.reply("No payment configurations found.");
    return;
  }
  
  const embed = new EmbedBuilder()
    .setTitle("💰 Payment Configuration")
    .setColor("#00AAFF")
    .setDescription("Current payment calculation settings");
    
  configs.forEach(config => {
    embed.addFields({
      name: formatConfigName(config.key),
      value: `**Value:** ${config.value}\n**Description:** ${config.description}`
    });
  });
  
  embed.setFooter({ text: "Use !warreport config set <key> <value> to modify" });
  
  await message.reply({ embeds: [embed] });
}

/**
 * Format config key for display
 */
function formatConfigName(key: string): string {
  return key.split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}