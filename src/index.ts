import { Client, Events, GatewayIntentBits, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, Message, EmbedBuilder } from "discord.js";

// Configuration constants
const DEFAULT_CHECK_INTERVAL = 20_000; // 20-second interval default
const MY_FACTION_ID = 41702; // Faction ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const API_KEY = process.env.TORN_API_KEY; // API Key for authentication
const CHANNEL_ID = "1345081433139712051"; // Discord channel where messages will be sent
const WAR_STATUS_URL = `https://api.torn.com/v2/faction/${MY_FACTION_ID}/wars`;

const PREFIX = "!"; // Command prefix

// Track monitoring state
interface MonitoringConfig {
    isActive: boolean;
    intervalId: NodeJS.Timeout | null;
    maxHospitalTime: number; // Maximum time in hospital to display (seconds)
    checkInterval: number; // How often to check (milliseconds)
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

// Store player messages to track updates (use weak map to allow garbage collection)
const playerMessages = new Map<number, string>();
// Store header and footer message IDs
let headerMessageId: string | null = null;
let footerMessageId: string | null = null;
// Store IDs for section headers and available target messages
let hospitalSectionId: string | null = null;
let availableSectionId: string | null = null;
const availableTargetMessages = new Set<string>();

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Client ready event handler
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  // Don't auto-start monitoring, wait for command
});

// Message handler for commands
client.on(Events.MessageCreate, async (message) => {
    // Ignore messages from bots or messages without the prefix
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;
    
    // Process the command
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    
    if (command === "monitor") {
        // !monitor start [maxTime] [interval] [factionId]
        // !monitor stop
        // !monitor status
        
        const action = args[0]?.toLowerCase();
        
        if (action === "start") {
            // Parse optional parameters
            const maxTime = parseInt(args[1]) || 5; // Default 5 minutes  
            const interval = parseInt(args[2]) || 20; // Default 20 seconds
            const factionId = parseInt(args[3]) || null; // Optional faction ID
            
            await startMonitoringCommand(message, maxTime, interval, factionId);
        } 
        else if (action === "stop") {
            await stopMonitoring(message);
        }
        else if (action === "status") {
            await showStatus(message);
        }
        else if (action === "clear") {
            const channel = message.channel as TextChannel;
            // Send the message before deleting everything
            await channel.send("Clearing all messages in the channel...");
            await clearAllMessages(channel, true); // Pass true to delete ALL messages
            // Send a new message after clearing since the original message is gone
            await channel.send("Channel cleared of all messages.");
        }
        else {
            await message.reply(
                "Usage:\n" +
                "`!monitor start [maxTime] [interval] [factionId]` - Start monitoring\n" +
                "  - maxTime: Maximum hospital time in minutes (default: 5)\n" +
                "  - interval: Check interval in seconds (default: 20)\n" +
                "  - factionId: Optional opponent faction ID (default: auto-detect from RW)\n" +
                "`!monitor stop` - Stop monitoring\n" +
                "`!monitor status` - Show monitoring status\n" +
                "`!monitor clear` - Clear all messages in channel"
            );
        }
    }
});

// Commands implementation
async function startMonitoringCommand(message: Message, maxTime: number, interval: number, factionId: number | null) {
    try {
        // Stop any existing monitoring
        if (monitoringConfig.isActive) {
            stopMonitoringInterval();
        }
        
        // Update config with new parameters
        monitoringConfig.maxHospitalTime = maxTime * 60; // Convert to seconds
        monitoringConfig.checkInterval = interval * 1000; // Convert to milliseconds
        
        // If faction ID is provided, use it
        if (factionId) {
            monitoringConfig.opponentFactionId = factionId;
            await message.reply(`Starting monitoring of faction ID: ${factionId} (Custom)`);
            startMonitoring(factionId);
            return;
        }
        
        // Otherwise, try to auto-detect from ranked war
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
            
            // Clean up the channel of existing messages
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
    
    // Clear cached message IDs to prevent memory leaks
    playerMessages.clear();
    headerMessageId = null;
    footerMessageId = null;
    hospitalSectionId = null;
    availableSectionId = null;
    availableTargetMessages.clear();
}

async function cleanupChannel(channel: TextChannel) {
    // Clean up only the bot's monitoring messages, not all messages
    try {
        if (headerMessageId) {
            try {
                const headerMessage = await channel.messages.fetch(headerMessageId);
                await headerMessage.delete();
            } catch (error) {
                console.error("Error deleting header message:", error);
            }
        }
        
        if (footerMessageId) {
            try {
                const footerMessage = await channel.messages.fetch(footerMessageId);
                await footerMessage.delete();
            } catch (error) {
                console.error("Error deleting footer message:", error);
            }
        }
        
        if (hospitalSectionId) {
            try {
                const hospitalHeader = await channel.messages.fetch(hospitalSectionId);
                await hospitalHeader.delete();
            } catch (error) {
                console.error("Error deleting hospital section header:", error);
            }
        }
        
        if (availableSectionId) {
            try {
                const availableHeader = await channel.messages.fetch(availableSectionId);
                await availableHeader.delete();
            } catch (error) {
                console.error("Error deleting available section header:", error);
            }
        }
        
        // Delete player messages
        for (const messageId of playerMessages.values()) {
            try {
                const message = await channel.messages.fetch(messageId);
                await message.delete();
            } catch (error) {
                console.error("Error deleting player message:", error);
            }
        }
        
        // Delete available target messages
        for (const messageId of availableTargetMessages) {
            try {
                const message = await channel.messages.fetch(messageId);
                await message.delete();
            } catch (error) {
                console.error("Error deleting available target message:", error);
            }
        }
    } catch (error) {
        console.error("Error cleaning up channel:", error);
    }
    
    // Reset all message tracking
    playerMessages.clear();
    headerMessageId = null;
    footerMessageId = null;
    hospitalSectionId = null;
    availableSectionId = null;
    availableTargetMessages.clear();
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
async function fetchFactionData() {
  try {
    const response = await fetch(WAR_STATUS_URL, {
      headers: { Authorization: `ApiKey ${API_KEY}` },
    });

    const data = await response.json();
    return data.members || [];
  } catch (error) {
    console.error("Error fetching faction data:", error);
    return [];
  }
}

const checkForActiveRW = async (): Promise<boolean> => { 
    try {
        const response = await fetch(WAR_STATUS_URL, {
            headers: { Authorization: `ApiKey ${API_KEY}` },
        });

        const data = await response.json();

        // Check if there is an active ranked war
        if (data.wars?.ranked && !data.wars.ranked.end) {
            console.log("There is an active ranked war");

            // Find the opponent faction's ID
            const factions = data.wars.ranked.factions;
            const opponentFaction: Faction | undefined = factions.find((faction: Faction) => faction.id !== MY_FACTION_ID);

            if (opponentFaction) {
                console.log(`Opponent Faction ID: ${opponentFaction.id}`);
                monitoringConfig.opponentFactionId = opponentFaction.id;
                startMonitoring(opponentFaction.id); // Pass opponent faction ID
                return true;
            } else {
                console.error("Opponent faction not found!");
                return false;
            }
        }

        return false; // No active ranked war
    } catch (error) {
        console.error("Error fetching faction war data:", error);
        return false;
    }
};

// Main monitoring function
const startMonitoring = async (opponentFactionId: number) => {
    console.log(`Monitoring opponent faction: ${opponentFactionId}`);

    // Use opponentFactionId in the API URL
    const API_URL = `https://api.torn.com/v2/faction/${opponentFactionId}/members?striptags=true`;

    // Stop any existing interval
    if (monitoringConfig.intervalId) {
        clearInterval(monitoringConfig.intervalId);
    }

    // Start new monitoring interval
    monitoringConfig.isActive = true;
    monitoringConfig.opponentFactionId = opponentFactionId;
    
    // Optimized: Use async intervals to prevent overlapping executions
    const runMonitoringCycle = async () => {
        try {
            const response = await fetch(API_URL, {
                headers: { Authorization: `ApiKey ${API_KEY}` },
            });

            const data = await response.json();
            const now = Math.floor(Date.now() / 1000);

            // Filter and sort members in hospital who will leave within the configured time range
            const soonToLeave = (Object.values(data.members) as Player[])
                .filter((player: Player) => {
                    return (
                        player.status.state === "Hospital" &&
                        player.status.until - now > 0 && // Just ensure they're still in hospital
                        player.status.until - now <= monitoringConfig.maxHospitalTime
                    );
                })
                .sort((a: Player, b: Player) => {
                    // Sorting by time left in the hospital (ascending)
                    return (a.status.until - now) - (b.status.until - now);
                });
                
            // Find available targets (not in hospital)
            const availableTargets = (Object.values(data.members) as Player[])
                .filter((player: Player) => player.status.state !== "Hospital")
                .sort((a: Player, b: Player) => a.level - b.level); // Sort by level (ascending)

            const channel = (await client.channels.fetch(CHANNEL_ID)) as TextChannel;
            
            // Optimization: Track player messages to avoid redundant operations
            const currentHospitalPlayers = new Set(soonToLeave.map(player => player.id));
            
            // Find players whose messages should be removed
            const playersToRemove = [...playerMessages.keys()].filter(playerId => 
                !currentHospitalPlayers.has(playerId)
            );
            
            // Remove messages for players no longer in the target criteria
            for (const playerId of playersToRemove) {
                const messageId = playerMessages.get(playerId);
                if (messageId) {
                    try {
                        const message = await channel.messages.fetch(messageId);
                        await message.delete();
                    } catch (error) {
                        console.error(`Error deleting message for player ${playerId}:`, error);
                    }
                    playerMessages.delete(playerId);
                }
            }
            
            // Create header if it doesn't exist
            if (!headerMessageId) {
                const headerMessage = await channel.send({ 
                    content: `━━━━━━━━━━━━━━ 🏥 **TARGET ALERTS** 🏥 ━━━━━━━━━━━━━━` 
                });
                headerMessageId = headerMessage.id;
            }

            // Handle available targets section
            // Optimization: Use a batch operation for deleting messages
            const messagesToDelete = [...availableTargetMessages].map(id => 
                channel.messages.fetch(id).then(msg => msg.delete())
            );
            await Promise.allSettled(messagesToDelete);
            availableTargetMessages.clear();
            
            if (availableTargets.length > 0) {
                // Update available section header
                if (availableSectionId) {
                    try {
                        await channel.messages.fetch(availableSectionId)
                            .then(header => header.delete())
                            .catch(() => console.error("Failed to delete available section header"));
                    } catch (error) {
                        console.error("Error with available section header:", error);
                    }
                }
                
                const availableHeader = await channel.send({ content: `**🎯 Available targets right now:**` });
                availableSectionId = availableHeader.id;
                
                // Limit to top 5 lowest level targets to avoid spam
                const topTargets = availableTargets.slice(0, 5);
                
                // Optimization: Prepare all messages before sending to reduce API calls
                const targetMessagePromises = topTargets.map(async (player) => {
                    const healthPct = player.life ? 
                        Math.floor((player.life.current/player.life.maximum)*100) : null;
                    
                    const attackButton = new ButtonBuilder()
                        .setLabel("⚔️ Attack")
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${player.id}`);
                        
                    const profileButton = new ButtonBuilder()
                        .setLabel("👤 Profile")
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://www.torn.com/profiles.php?XID=${player.id}`);

                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(attackButton, profileButton);

                    const embed = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle(`${player.name} (Lvl ${player.level})`)
                        .setDescription(
                            `✅ **AVAILABLE NOW**\n` +
                            `🏢 ${player.position} • 📅 ${player.days_in_faction}d in faction` +
                            (healthPct ? ` • ❤️ ${healthPct}%` : '') +
                            `\n⌚ ${player.last_action?.relative || 'Unknown'}`
                        )
                        .setFooter({ text: player.status?.description || '' });

                    return { embeds: [embed], components: [row] };
                });
                
                // Send all available target messages
                const messageContents = await Promise.all(targetMessagePromises);
                for (const content of messageContents) {
                    const targetMessage = await channel.send(content);
                    availableTargetMessages.add(targetMessage.id);
                }
            } else if (availableSectionId) {
                try {
                    await channel.messages.fetch(availableSectionId)
                        .then(header => header.delete())
                        .catch(() => {});
                    availableSectionId = null;
                } catch (error) {
                    console.error("Error deleting available section header:", error);
                    availableSectionId = null;
                }
            }

            // Handle hospital section
            if (soonToLeave.length > 0) {
                if (!hospitalSectionId) {
                    const hospitalHeader = await channel.send({ content: `\n**🏥 Players leaving hospital soon:**` });
                    hospitalSectionId = hospitalHeader.id;
                }
                
                // Prepare all hospital player embeds first
                const playerUpdates = soonToLeave.map(async (player) => {
                    const secondsLeft = player.status.until - now;
                    const minutesLeft = Math.floor(secondsLeft / 60);
                    const remainingSeconds = secondsLeft % 60;
                    
                    const countdownText = `${minutesLeft}m ${remainingSeconds}s`;
                    
                    const healthPct = player.life ? 
                        Math.floor((player.life.current/player.life.maximum)*100) : null;
                    
                    const attackButton = new ButtonBuilder()
                        .setLabel("⚔️ Attack")
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${player.id}`);
                        
                    const profileButton = new ButtonBuilder()
                        .setLabel("👤 Profile")
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://www.torn.com/profiles.php?XID=${player.id}`);

                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(attackButton, profileButton);

                    const embed = new EmbedBuilder()
                        .setColor('#FF4500')
                        .setTitle(`${player.name} (Lvl ${player.level})`)
                        .setDescription(
                            `⏰ **Hospital Exit:** <t:${player.status.until}:R> (${countdownText})\n` +
                            `🏢 ${player.position} • 📅 ${player.days_in_faction}d in faction` +
                            (healthPct ? ` • ❤️ ${healthPct}%` : '') + 
                            `\n⌚ ${player.last_action?.relative || 'Unknown'} • ` +
                            `${player.is_revivable ? '✅ Revivable' : '❌ Not revivable'}` +
                            `${player.has_early_discharge ? ' • ⚡ Early discharge' : ''}`
                        )
                        .setFooter({ text: player.status.description || '' });

                    return {
                        playerId: player.id,
                        embed,
                        row,
                    };
                });
                
                // Process all updates
                const updates = await Promise.all(playerUpdates);
                
                // Apply updates optimally (update existing or create new)
                for (const update of updates) {
                    if (playerMessages.has(update.playerId)) {
                        try {
                            const messageId = playerMessages.get(update.playerId)!;
                            const message = await channel.messages.fetch(messageId);
                            
                            await message.edit({
                                embeds: [update.embed],
                                components: [update.row]
                            });
                        } catch (error) {
                            console.error(`Error updating message for player ${update.playerId}:`, error);
                            const newMessage = await channel.send({
                                embeds: [update.embed],
                                components: [update.row]
                            });
                            playerMessages.set(update.playerId, newMessage.id);
                        }
                    } else {
                        const newMessage = await channel.send({
                            embeds: [update.embed],
                            components: [update.row]
                        });
                        playerMessages.set(update.playerId, newMessage.id);
                    }
                }
            } else if (hospitalSectionId) {
                try {
                    await channel.messages.fetch(hospitalSectionId)
                        .then(header => header.delete())
                        .catch(() => {});
                    hospitalSectionId = null;
                } catch (error) {
                    console.error("Error deleting hospital section header:", error);
                    hospitalSectionId = null;
                }
            }
            
            // Create or update footer
            if (!footerMessageId) {
                const footerMessage = await channel.send({
                    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
                });
                footerMessageId = footerMessage.id;
            }
            
            // Clean up if there's nothing to show
            if (soonToLeave.length === 0 && availableTargets.length === 0) {
                if (headerMessageId) {
                    try {
                        await channel.messages.fetch(headerMessageId)
                            .then(msg => msg.delete())
                            .catch(() => {});
                        headerMessageId = null;
                    } catch (error) {
                        console.error("Error deleting header message:", error);
                    }
                }
                
                if (footerMessageId) {
                    try {
                        await channel.messages.fetch(footerMessageId)
                            .then(msg => msg.delete())
                            .catch(() => {});
                        footerMessageId = null;
                    } catch (error) {
                        console.error("Error deleting footer message:", error);
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

// Function to clear all messages in a channel
async function clearAllMessages(channel: TextChannel, deleteAllMessages = false) {
    console.log(`Clearing ${deleteAllMessages ? 'all' : 'bot'} messages in channel: ${channel.name}`);
    
    try {
        // Optimized: Fetch messages in batches for faster processing
        const fetchAndDeleteBatch = async (lastId?: string) => {
            const options: { limit: number; before?: string } = { limit: 100 };
            if (lastId) options.before = lastId;
            
            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) return false;
            
            // Filter messages - either all messages or just bot messages
            const messagesToDelete = deleteAllMessages ? 
                messages : 
                messages.filter(msg => msg.author.id === client.user?.id);
                
            if (messagesToDelete.size === 0) return messages.size === 100;
            
            // Use bulk delete for recent messages (< 14 days)
            const recentMessages = messagesToDelete.filter(msg => 
                Date.now() - msg.createdTimestamp < 1209600000
            );
            
            if (recentMessages.size > 1) {
                await channel.bulkDelete(recentMessages);
            } else if (recentMessages.size === 1) {
                await recentMessages.first()?.delete();
            }
            
            // Handle older messages individually
            const oldMessages = messagesToDelete.filter(msg => 
                Date.now() - msg.createdTimestamp >= 1209600000
            );
            
            for (const [_, message] of oldMessages) {
                await message.delete().catch(() => {}); // Ignore errors
                await new Promise(resolve => setTimeout(resolve, 500)); // Reduce rate limiting
            }
            
            // Return true if we need to fetch more messages
            return messages.size === 100;
        };
        
        // Keep fetching and deleting in batches until done
        let hasMore = true;
        let lastId;
        
        while (hasMore) {
            hasMore = await fetchAndDeleteBatch(lastId);
            if (hasMore && channel.messages.cache.size > 0) {
                lastId = channel.messages.cache.lastKey();
            }
        }
        
        console.log("Channel cleared successfully");
    } catch (error) {
        console.error("Error clearing messages:", error);
    }
}

// Start the bot
client.login(BOT_TOKEN);

// Type definitions
interface Faction {
    id: number;
    name: string;
}

interface WarData {
    ranked: {
        end: number | null;
        factions: Faction[];
    };
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