import { Client, Events, GatewayIntentBits, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
         Message, EmbedBuilder, ButtonInteraction, Collection, Interaction, MessageFlags } from "discord.js";
import { handleWarReportCommand, handleWarReportButton } from './warReport';

// Configuration constants
const DEFAULT_CHECK_INTERVAL = 20_000;
const MY_FACTION_ID = 41702;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const API_KEY = process.env.TORN_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WAR_STATUS_URL = `https://api.torn.com/v2/faction/${MY_FACTION_ID}/wars`;
const PREFIX = "!";

// Track monitoring state
interface MonitoringConfig {
    isActive: boolean;
    intervalId: NodeJS.Timeout | null;
    maxHospitalTime: number;
    checkInterval: number;
    opponentFactionId: number | null;
}

// Default configuration
const monitoringConfig: MonitoringConfig = {
    isActive: false,
    intervalId: null,
    maxHospitalTime: 300, // 5 minutes maximum
    checkInterval: DEFAULT_CHECK_INTERVAL,
    opponentFactionId: null
};

// Message tracking maps
const playerMessages = new Map<number, {messageId: string, state: string}>(); // Track player state
const dibsRegistry = new Map<number, { userId: string, username: string, timestamp: number }>();

// Header tracking
let headerMessageId: string | null = null;
let footerMessageId: string | null = null;

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

// Message handler with channel restriction
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;
    if (message.channelId !== CHANNEL_ID) return;
    
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    
    if (command === "monitor") {
        const action = args[0]?.toLowerCase();
        
        switch(action) {
            case "start":
                const maxTime = parseInt(args[1]) || 5;
                const interval = parseInt(args[2]) || 20;
                const factionId = parseInt(args[3]) || null;
                await startMonitoringCommand(message, maxTime, interval, factionId);
                break;
                
            case "stop":
                await stopMonitoring(message);
                break;
                
            case "status":
                await showStatus(message);
                break;
                
            case "clear":
                const channel = message.channel as TextChannel;
                await channel.send("Clearing all messages in the channel...");
                await clearAllMessages(channel, true);
                await channel.send("Channel cleared of all messages.");
                break;
                
            case "dibs":
                await showDibsList(message);
                break;
                
            default:
                await message.reply(
                    "Usage:\n" +
                    "`!monitor start [maxTime] [interval] [factionId]` - Start monitoring\n" +
                    "  - maxTime: Maximum hospital time in minutes (default: 5)\n" +
                    "  - interval: Check interval in seconds (default: 20)\n" +
                    "  - factionId: Optional opponent faction ID (default: auto-detect from RW)\n" +
                    "`!monitor stop` - Stop monitoring\n" +
                    "`!monitor status` - Show monitoring status\n" +
                    "`!monitor clear` - Clear all messages in channel\n" +
                    "`!monitor dibs` - Show current target claims"
                );
        }
    } 
    else if (command === "warreport") {
        await handleWarReportCommand(message, args);
    }
});

// Handle button interactions
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.channelId !== CHANNEL_ID) {
        await interaction.reply({ 
            content: "Button interactions can only be used in the designated channel.", 
            flags: MessageFlags.Ephemeral 
        });
        return;
    }
    
    const customId = interaction.customId;
    if (customId.startsWith('dibs_')) {
        await handleDibsButton(interaction);
    } 
    else if (customId.startsWith('warreport_') || customId.startsWith('pay_')) {
        await handleWarReportButton(interaction);
    }
});

// Command implementations
async function startMonitoringCommand(message: Message, maxTime: number, interval: number, factionId: number | null) {
    try {
        if (monitoringConfig.isActive) {
            stopMonitoringInterval();
        }
        
        monitoringConfig.maxHospitalTime = maxTime * 60;
        monitoringConfig.checkInterval = interval * 1000;
        
        if (factionId) {
            monitoringConfig.opponentFactionId = factionId;
            await message.reply(`Starting monitoring of faction ID: ${factionId} (Custom)`);
            startMonitoring(factionId);
            return;
        }
        
        const hasRW = await checkForActiveRW();
        
        if (!hasRW) {
            await message.reply("No active ranked war detected. Please specify a faction ID.");
        } else {
            await message.reply(`Started monitoring faction ID: ${monitoringConfig.opponentFactionId} (RW opponent)\nSettings: 0-${maxTime}m range, checking every ${interval}s`);
        }
    } catch (error) {
        console.error("Error starting monitoring:", error);
        await message.reply("Error starting monitoring. Check logs for details.");
    }
}

async function stopMonitoring(message: Message) {
    try {
        if (monitoringConfig.isActive) {
            stopMonitoringInterval();
            await message.reply("Monitoring stopped.");
            
            const channel = message.channel as TextChannel;
            await cleanupChannel(channel);
        } else {
            await message.reply("Monitoring was not active.");
        }
    } catch (error) {
        console.error("Error stopping monitoring:", error);
        await message.reply("Error stopping monitoring. Check logs for details.");
    }
}

function stopMonitoringInterval() {
    if (monitoringConfig.intervalId) {
        clearInterval(monitoringConfig.intervalId);
        monitoringConfig.intervalId = null;
    }
    monitoringConfig.isActive = false;
    
    // Clear tracking data
    playerMessages.clear();
    headerMessageId = null;
    footerMessageId = null;
}

async function cleanupChannel(channel: TextChannel) {
    try {
        // Delete all messages tracked by the bot
        const deletionPromises = [];
        
        if (headerMessageId) {
            deletionPromises.push(channel.messages.fetch(headerMessageId)
                .then(msg => msg.delete())
                .catch(err => console.error("Error deleting header message:", err)));
            headerMessageId = null;
        }
        
        if (footerMessageId) {
            deletionPromises.push(channel.messages.fetch(footerMessageId)
                .then(msg => msg.delete())
                .catch(err => console.error("Error deleting footer message:", err)));
            footerMessageId = null;
        }
        
        // Delete all player messages
        for (const playerData of playerMessages.values()) {
            deletionPromises.push(channel.messages.fetch(playerData.messageId)
                .then(msg => msg.delete())
                .catch(err => console.error(`Error deleting player message:`, err)));
        }
        
        // Wait for all deletions to complete
        await Promise.allSettled(deletionPromises);
        playerMessages.clear();
        
    } catch (error) {
        console.error("Error cleaning up channel:", error);
    }
}

async function showStatus(message: Message) {
    if (monitoringConfig.isActive) {
        await message.reply(
            "Monitoring Status: **Active**\n" + 
            `Faction ID: ${monitoringConfig.opponentFactionId}\n` +
            `Hospital Time Range: 0-${monitoringConfig.maxHospitalTime/60} minutes\n` +
            `Check Interval: ${monitoringConfig.checkInterval/1000} seconds`
        );
    } else {
        await message.reply("Monitoring Status: **Inactive**");
    }
}

// Data fetching functions
const checkForActiveRW = async (): Promise<boolean> => { 
    try {
        const response = await fetch(WAR_STATUS_URL, {
            headers: { Authorization: `ApiKey ${API_KEY}` },
        });

        const data = await response.json();

        if (data.wars?.ranked && !data.wars.ranked.end) {
            console.log("There is an active ranked war");

            const factions = data.wars.ranked.factions;
            const opponentFaction: Faction | undefined = factions.find((faction: Faction) => faction.id !== MY_FACTION_ID);

            if (opponentFaction) {
                console.log(`Opponent Faction ID: ${opponentFaction.id}`);
                monitoringConfig.opponentFactionId = opponentFaction.id;
                startMonitoring(opponentFaction.id);
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error("Error fetching faction war data:", error);
        return false;
    }
};

// Main monitoring function
const startMonitoring = async (opponentFactionId: number) => {
    console.log(`Monitoring opponent faction: ${opponentFactionId}`);
    const API_URL = `https://api.torn.com/v2/faction/${opponentFactionId}/members?striptags=true`;

    if (monitoringConfig.intervalId) {
        clearInterval(monitoringConfig.intervalId);
    }

    monitoringConfig.isActive = true;
    monitoringConfig.opponentFactionId = opponentFactionId;
    
    const runMonitoringCycle = async () => {
        try {
            const response = await fetch(API_URL, {
                headers: { Authorization: `ApiKey ${API_KEY}` },
            });

            const data = await response.json();
            const now = Math.floor(Date.now() / 1000);

            // Process all members first
            const memberPromises = Object.values(data.members || {}).map(async (player: Player) => {
                const isInHospital = player.status.state === "Hospital";
                const hospitalTimeLeft = isInHospital ? player.status.until - now : 0;
                const inTargetTimeRange = isInHospital && hospitalTimeLeft <= monitoringConfig.maxHospitalTime && hospitalTimeLeft > 0;
                
                // Get player's current tracked state
                const currentTracking = playerMessages.get(player.id);
                
                // Determine if we need to update this player
                let needsUpdate = false;
                let needsDeletion = false;
                
                if (currentTracking) {
                    // Cases when we need to update:
                    // 1. Player was in hospital but now available
                    // 2. Player was available but now in hospital within our time range
                    // 3. Player still in hospital but time changed significantly
                    if (currentTracking.state === 'hospital' && !inTargetTimeRange) {
                        needsDeletion = true;
                    } else if (currentTracking.state === 'available' && !inTargetTimeRange) {
                        needsDeletion = true;
                    } else if (currentTracking.state === 'available' && inTargetTimeRange) {
                        needsUpdate = true;
                    } else if (inTargetTimeRange) {
                        needsUpdate = true;
                    }
                } else if (inTargetTimeRange || (!isInHospital && player.level <= 100)) {
                    // New player that fits our criteria
                    needsUpdate = true;
                }
                
                return {
                    player,
                    needsUpdate,
                    needsDeletion,
                    isInHospital,
                    inTargetTimeRange
                };
            });
            
            // Wait for all processing to complete
            const processedMembers = await Promise.all(memberPromises);
            
            const channel = await client.channels.fetch(CHANNEL_ID) as TextChannel;
            
            // Create header if it doesn't exist
            if (!headerMessageId && processedMembers.some(m => m.needsUpdate)) {
                const headerMessage = await channel.send({ 
                    content: `━━━━━━━━━━━━━━ 🏥 **TARGET ALERTS** 🏥 ━━━━━━━━━━━━━━` 
                });
                headerMessageId = headerMessage.id;
            }
            
            // Delete messages for players who no longer fit criteria
            const deletionPromises = processedMembers
                .filter(m => m.needsDeletion)
                .map(async ({ player }) => {
                    const tracking = playerMessages.get(player.id);
                    if (tracking) {
                        try {
                            const message = await channel.messages.fetch(tracking.messageId);
                            await message.delete();
                        } catch (error) {
                            console.error(`Error deleting message for player ${player.id}:`, error);
                        }
                        playerMessages.delete(player.id);
                    }
                });
                
            await Promise.allSettled(deletionPromises);
            
            // Update players who need it
            for (const { player, needsUpdate, isInHospital, inTargetTimeRange } of processedMembers) {
                if (!needsUpdate) continue;
                
                // Prepare embed and message content based on player state
                const dibsClaimed = dibsRegistry.has(player.id);
                const healthPct = player.life ? 
                    Math.floor((player.life.current/player.life.maximum)*100) : null;
                
                // Create attack and profile buttons
                const attackButton = new ButtonBuilder()
                    .setLabel("⚔️ Attack")
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${player.id}`);
                    
                const profileButton = new ButtonBuilder()
                    .setLabel("👤 Profile")
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://www.torn.com/profiles.php?XID=${player.id}`);
                
                // Create dibs button
                const dibsButton = new ButtonBuilder()
                    .setLabel(dibsClaimed ? "👑 Claimed" : "🎯 Dibs")
                    .setStyle(dibsClaimed ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setCustomId(`dibs_${player.id}`);
                
                const row = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(attackButton, profileButton, dibsButton);
                
                // Build dibs info if claimed
                let dibsInfo = '';
                if (dibsClaimed) {
                    const claimer = dibsRegistry.get(player.id)!;
                    dibsInfo = `\n👑 **Claimed by ${claimer.username}**`;
                }
                
                let embed: EmbedBuilder;
                let currentState: string;
                
                if (inTargetTimeRange) {
                    // Player in hospital within our time range
                    currentState = 'hospital';
                    const secondsLeft = player.status.until - now;
                    const minutesLeft = Math.floor(secondsLeft / 60);
                    const remainingSeconds = secondsLeft % 60;
                    const countdownText = `${minutesLeft}m ${remainingSeconds}s`;
                    
                    embed = new EmbedBuilder()
                        .setColor(dibsClaimed ? '#FFD700' : '#FF4500') // Gold if claimed, orange if not
                        .setTitle(`${player.name} (Lvl ${player.level})`)
                        .setDescription(
                            `⏰ **Hospital Exit:** <t:${player.status.until}:R> (${countdownText})\n` +
                            `🏢 ${player.position} • 📅 ${player.days_in_faction}d in faction` +
                            (healthPct ? ` • ❤️ ${healthPct}%` : '') + 
                            `\n⌚ ${player.last_action?.relative || 'Unknown'} • ` +
                            `${player.is_revivable ? '✅ Revivable' : '❌ Not revivable'}` +
                            `${player.has_early_discharge ? ' • ⚡ Early discharge' : ''}` +
                            dibsInfo
                        )
                        .setFooter({ text: player.status.description || '' });
                } else {
                    // Available player
                    currentState = 'available';
                    embed = new EmbedBuilder()
                        .setColor(dibsClaimed ? '#FFD700' : '#00FF00') // Gold if claimed, green if not
                        .setTitle(`${player.name} (Lvl ${player.level})`)
                        .setDescription(
                            `✅ **AVAILABLE NOW**\n` +
                            `🏢 ${player.position} • 📅 ${player.days_in_faction}d in faction` +
                            (healthPct ? ` • ❤️ ${healthPct}%` : '') +
                            `\n⌚ ${player.last_action?.relative || 'Unknown'}` +
                            dibsInfo
                        )
                        .setFooter({ text: player.status?.description || '' });
                }
                
                // Update or create message
                const tracking = playerMessages.get(player.id);
                if (tracking) {
                    try {
                        const message = await channel.messages.fetch(tracking.messageId);
                        await message.edit({
                            embeds: [embed],
                            components: [row]
                        });
                        playerMessages.set(player.id, { messageId: tracking.messageId, state: currentState });
                    } catch (error) {
                        console.error(`Error updating message for player ${player.id}:`, error);
                        // If message can't be updated, create a new one
                        const newMessage = await channel.send({
                            embeds: [embed],
                            components: [row]
                        });
                        playerMessages.set(player.id, { messageId: newMessage.id, state: currentState });
                    }
                } else {
                    // Create a new message
                    const newMessage = await channel.send({
                        embeds: [embed],
                        components: [row]
                    });
                    playerMessages.set(player.id, { messageId: newMessage.id, state: currentState });
                }
            }
            
            // Create or update footer if needed
            if (!footerMessageId && playerMessages.size > 0) {
                const footerMessage = await channel.send({
                    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
                });
                footerMessageId = footerMessage.id;
            }
            
            // Clean up if there's nothing to show
            if (playerMessages.size === 0) {
                if (headerMessageId) {
                    try {
                        await channel.messages.fetch(headerMessageId)
                            .then(msg => msg.delete())
                            .catch(() => {});
                        headerMessageId = null;
                    } catch (error) {
                        headerMessageId = null;
                    }
                }
                
                if (footerMessageId) {
                    try {
                        await channel.messages.fetch(footerMessageId)
                            .then(msg => msg.delete())
                            .catch(() => {});
                        footerMessageId = null;
                    } catch (error) {
                        footerMessageId = null;
                    }
                }
            }
        } catch (error) {
            console.error("Error fetching opponent faction data:", error);
        }
    };

    // Do one immediate run
    await runMonitoringCycle();
    
    // Then set up interval
    monitoringConfig.intervalId = setInterval(runMonitoringCycle, monitoringConfig.checkInterval) as NodeJS.Timeout;
};

// Handler function for dibs buttons
async function handleDibsButton(interaction: ButtonInteraction) {
    try {
        const playerId = parseInt(interaction.customId.split('_')[1]);
        const user = interaction.user;
        let responseMessage = "";
        
        if (dibsRegistry.has(playerId)) {
            const existingDibs = dibsRegistry.get(playerId)!;
            
            if (existingDibs.userId === user.id) {
                dibsRegistry.delete(playerId);
                responseMessage = `You've released your claim on this target`;
            } else {
                responseMessage = `Target already claimed by ${existingDibs.username}! Please choose another target.`;
                await interaction.reply({ content: responseMessage, flags: MessageFlags.Ephemeral });
                return;
            }
        } else {
            dibsRegistry.set(playerId, {
                userId: user.id,
                username: user.username,
                timestamp: Date.now()
            });
            responseMessage = `You've claimed this target! Good hunting!`;
        }
        
        await interaction.reply({ content: responseMessage, flags: MessageFlags.Ephemeral });
        
        // Update the message
        try {
            const message = interaction.message;
            if (!message) return;
            
            const channel = interaction.channel as TextChannel;
            if (!channel) return;
            
            let msg;
            try {
                msg = await channel.messages.fetch(message.id);
            } catch (err) {
                return;
            }
            
            const oldEmbed = msg.embeds[0];
            if (!oldEmbed) return;
            
            const playerData = playerMessages.get(playerId);
            if (!playerData) return;
            
            const isHospital = playerData.state === 'hospital';
            const newEmbed = EmbedBuilder.from(oldEmbed);
            
            newEmbed.setColor(dibsRegistry.has(playerId) ? '#FFD700' : (isHospital ? '#FF4500' : '#00FF00'));
            
            let description = oldEmbed.description || '';
            description = description.replace(/\n👑 \*\*Claimed by .*?\*\*/g, '');
            
            if (dibsRegistry.has(playerId)) {
                const claimer = dibsRegistry.get(playerId)!;
                description += `\n👑 **Claimed by ${claimer.username}**`;
            }
            
            newEmbed.setDescription(description);
            
            try {
                const components = message.components;
                if (components && components.length > 0 && components[0].components.length > 2) {
                    const attackButton = ButtonBuilder.from(components[0].components[0] as any);
                    const profileButton = ButtonBuilder.from(components[0].components[1] as any);
                    const dibsButton = new ButtonBuilder()
                        .setLabel(dibsRegistry.has(playerId) ? "👑 Claimed" : "🎯 Dibs")
                        .setStyle(dibsRegistry.has(playerId) ? ButtonStyle.Success : ButtonStyle.Primary)
                        .setCustomId(`dibs_${playerId}`);
                        
                    const row = new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(attackButton, profileButton, dibsButton);
                    
                    await msg.edit({ embeds: [newEmbed], components: [row] }).catch(() => {});
                }
            } catch (error) {
                console.error("Error updating components:", error);
            }
        } catch (error) {
            console.error("Error updating message after dibs:", error);
        }
    } catch (error) {
        console.error("Error handling dibs button:", error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: "Sorry, there was an error processing your request.", 
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }
}

// Function to display all current dibs
async function showDibsList(message: Message) {
    if (dibsRegistry.size === 0) {
        await message.reply("No targets have been claimed yet.");
        return;
    }
    
    const embed = new EmbedBuilder()
        .setTitle("🎯 Current Target Claims")
        .setColor('#FFD700')
        .setDescription("The following targets have been claimed:");
    
    // Add each claimed target to the embed
    for (const [playerId, claimer] of dibsRegistry.entries()) {
        const playerData = playerMessages.get(playerId);
        let playerName = `Target ID: ${playerId}`;
        
        // Try to get player name from messages
        if (playerData) {
            try {
                const channel = message.channel as TextChannel;
                const playerMsg = await channel.messages.fetch(playerData.messageId);
                if (playerMsg.embeds[0]?.title) {
                    playerName = playerMsg.embeds[0].title;
                }
            } catch (error) {}
        }
        
        const timeElapsed = Math.floor((Date.now() - claimer.timestamp) / 60000); // in minutes
        
        embed.addFields({
            name: playerName,
            value: `Claimed by: **${claimer.username}** (${timeElapsed} min ago)`
        });
    }
    
    await message.reply({ embeds: [embed] });
}

// Function to clear all messages in a channel
async function clearAllMessages(channel: TextChannel, deleteAllMessages = false) {
    console.log(`Clearing ${deleteAllMessages ? 'all' : 'bot'} messages in channel: ${channel.name}`);
    
    try {
        const fetchAndDeleteBatch = async (lastId?: string) => {
            const options: { limit: number; before?: string } = { limit: 100 };
            if (lastId) options.before = lastId;
            
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) return false;
            
            const messagesToDelete = deleteAllMessages ? 
                messages : 
                messages.filter(msg => msg.author.id === client.user?.id);
                
            if (messagesToDelete.size === 0) return messages.size === 100;
            
            const recentMessages = messagesToDelete.filter(msg => 
                Date.now() - msg.createdTimestamp < 1209600000
            );
            
            if (recentMessages.size > 1) {
                await channel.bulkDelete(recentMessages);
            } else if (recentMessages.size === 1) {
                await recentMessages.first()?.delete();
            }
            
            const oldMessages = messagesToDelete.filter(msg => 
                Date.now() - msg.createdTimestamp >= 1209600000
            );
            
            for (const message of oldMessages.values()) {
                await message.delete().catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            return messages.size === 100;
        };
        
        let hasMore = true;
        let lastId;
        
        while (hasMore) {
            hasMore = await fetchAndDeleteBatch(lastId);
            if (hasMore && channel.messages.cache.size > 0) {
                lastId = channel.messages.cache.lastKey();
            }
        }
        
        // Reset tracking variables
        headerMessageId = null;
        footerMessageId = null;
        playerMessages.clear();
        
        console.log("Channel cleared successfully");
    } catch (error) {
        console.error("Error clearing messages:", error);
    }
}

// Type definitions
interface Faction {
    id: number;
    name: string;
}

interface LastAction {
    status: string;
    timestamp: number;
    relative: string;
}

interface Status {
    description: string;
    details: string;
    state: string;
    until: number;
}

interface Life {
    current: number;
    maximum: number;
}

interface Player {
    id: number;
    name: string;
    level: number;
    days_in_faction: number;
    last_action: LastAction;
    status: Status;
    life: Life;
    revive_setting: string;
    position: string;
    is_revivable: boolean;
    is_on_wall: boolean;
    is_in_oc: boolean;
    has_early_discharge: boolean;
}

// Export function for server.ts
export async function startBot() {
  try {
    await client.login(BOT_TOKEN);
    console.log("Bot started successfully");
    return client;
  } catch (error) {
    console.error("Failed to start bot:", error);
    throw error;
  }
}