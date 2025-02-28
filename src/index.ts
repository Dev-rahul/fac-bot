import { Client, Events, GatewayIntentBits, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, Message, EmbedBuilder } from "discord.js";

const MY_FACTION_ID = 41702; // Faction ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const API_KEY = process.env.TORN_API_KEY // API Key for authentication
const CHANNEL_ID = "1345081433139712051"; // Discord channel where messages will be sent
const CHECK_INTERVAL = 60_000; // 1-minute interval

const WAR_STATUS_URL = `https://api.torn.com/v2/faction/${MY_FACTION_ID}/wars`;

// Store player messages to track updates
const playerMessages = new Map<number, string>();
// Store header and footer message IDs
let headerMessageId: string | null = null;
let footerMessageId: string | null = null;
// Store IDs for section headers and available target messages
let hospitalSectionId: string | null = null;
let availableSectionId: string | null = null;
const availableTargetMessages = new Set<string>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  checkForActiveRW();
 
});

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
                startMonitoring(opponentFaction.id); // Pass opponent faction ID
            } else {
                console.error("Opponent faction not found!");
            }

            return true;
        }

        return false; // No active ranked war
    } catch (error) {
        console.error("Error fetching faction war data:", error);
        return false;
    }
};


const startMonitoring = async (opponentFactionId: number) => {
    console.log(`Monitoring opponent faction: ${opponentFactionId}`);

    // Use opponentFactionId in the API URL
    const API_URL = `https://api.torn.com/v2/faction/${opponentFactionId}/members?striptags=true`;

    setInterval(async () => {
        try {
            const response = await fetch(API_URL, {
                headers: { Authorization: `ApiKey ${API_KEY}` },
            });

            const data = await response.json();
            const now = Math.floor(Date.now() / 1000);

            // Filter and sort members in hospital who will leave in 1-5 minutes
            const soonToLeave = (Object.values(data.members) as Player[])
                .filter((player: Player) => {
                    return (
                        player.status.state === "Hospital" &&
                        player.status.until - now > 60 && 
                        player.status.until - now <= 300
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
            
            // Clear all messages in the channel
            await clearAllMessages(channel);
            
            // Reset all tracking variables since we've cleared the channel
            playerMessages.clear();
            availableTargetMessages.clear();
            headerMessageId = null;
            footerMessageId = null;
            hospitalSectionId = null;
            availableSectionId = null;

            // Handle content based on whether we have players to display
            if (soonToLeave.length > 0 || availableTargets.length > 0) {
                // Create header
                const headerMessage = await channel.send({ 
                    content: `━━━━━━━━━━━━━━ 🏥 **TARGET ALERTS** 🏥 ━━━━━━━━━━━━━━` 
                });
                headerMessageId = headerMessage.id;

                // If we have hospital exits coming up, show them first
                if (soonToLeave.length > 0) {
                    const hospitalHeader = await channel.send({ content: `**🏥 Players leaving hospital soon:**` });
                    hospitalSectionId = hospitalHeader.id;
                    
                    // Process each player leaving hospital soon
                    for (const player of soonToLeave) {
                        const secondsLeft = player.status.until - now;
                        const minutesLeft = Math.floor(secondsLeft / 60);
                        const remainingSeconds = secondsLeft % 60;
                        
                        // Format countdown with minutes and seconds for text display
                        const countdownText = `**${minutesLeft}m ${remainingSeconds}s**`;
                        
                        // Calculate the timestamp for when the player will leave hospital
                        const exitTimestamp = player.status.until * 1000; // Convert to milliseconds
                        
                        // Format life status if available
                        const lifeStatus = player.life ? 
                            `Health: ${player.life.current}/${player.life.maximum} (${Math.floor((player.life.current/player.life.maximum)*100)}%)` : '';
                        
                        // Last action time
                        const lastActionInfo = player.last_action ? 
                            `Last Action: ${player.last_action.relative}` : '';
                            
                        // Create attack button
                        const attackButton = new ButtonBuilder()
                            .setLabel("⚔️ Attack Now")
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${player.id}`);
                            
                        const profileButton = new ButtonBuilder()
                            .setLabel("👤 View Profile")
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://www.torn.com/profiles.php?XID=${player.id}`);

                        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(attackButton, profileButton);

                        // Create embed with countdown timer
                        const embed = new EmbedBuilder()
                            .setColor('#FF4500')
                            .setTitle(`${player.name} (Level ${player.level})`)
                            .setDescription(`🔥 **TARGET OPPORTUNITY** 🔥`)
                            .addFields(
                                { name: '⏰ Hospital Exit', value: `<t:${player.status.until}:R>`, inline: true },
                                { name: '🏢 Position', value: player.position, inline: true },
                                { name: '📅 Faction Loyalty', value: `${player.days_in_faction} days`, inline: true },
                                { name: '🔍 Status', value: player.status.description || 'Unknown' }
                            )
                            .setFooter({ text: `Exact Exit: ${countdownText}` })
                            .setTimestamp(new Date(exitTimestamp));

                        // Add health field if available
                        if (player.life) {
                            embed.addFields({ 
                                name: '❤️ Health', 
                                value: `${player.life.current}/${player.life.maximum} (${Math.floor((player.life.current/player.life.maximum)*100)}%)`, 
                                inline: true 
                            });
                        }

                        // Add last action if available
                        if (player.last_action) {
                            embed.addFields({ 
                                name: '⌚ Last Action', 
                                value: player.last_action.relative, 
                                inline: true 
                            });
                        }

                        // Add revivable status
                        embed.addFields({
                            name: '🚑 Revive Status',
                            value: `${player.is_revivable ? '✅ Can be revived' : '❌ Cannot be revived'}${player.has_early_discharge ? ' | ⚡ Has early discharge' : ''}`,
                            inline: false
                        });

                        // Create a new message for this player
                        const newMessage = await channel.send({
                            embeds: [embed],
                            components: [row]
                        });
                        playerMessages.set(player.id, newMessage.id);
                    }
                }
                
                // Show available targets (not in hospital)
                if (availableTargets.length > 0) {
                    // Limit to top 5 lowest level targets to avoid spam
                    const topTargets = availableTargets.slice(0, 5);
                    
                    const availableHeader = await channel.send({ content: `\n**🎯 Available targets right now:**` });
                    availableSectionId = availableHeader.id;
                    
                    for (const player of topTargets) {
                        // Create attack button
                        const attackButton = new ButtonBuilder()
                            .setLabel("⚔️ Attack Now")
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${player.id}`);
                            
                        const profileButton = new ButtonBuilder()
                            .setLabel("👤 View Profile")
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://www.torn.com/profiles.php?XID=${player.id}`);

                        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(attackButton, profileButton);

                        // Create embed for available target
                        const embed = new EmbedBuilder()
                            .setColor('#00FF00') // Green for available targets
                            .setTitle(`${player.name} (Level ${player.level})`)
                            .setDescription(`✅ **AVAILABLE NOW**`)
                            .addFields(
                                { name: '🏢 Position', value: player.position, inline: true },
                                { name: '📅 Faction Loyalty', value: `${player.days_in_faction} days`, inline: true }
                            );

                        // Add health field if available
                        if (player.life) {
                            embed.addFields({ 
                                name: '❤️ Health', 
                                value: `${player.life.current}/${player.life.maximum} (${Math.floor((player.life.current/player.life.maximum)*100)}%)`, 
                                inline: true 
                            });
                        }

                        // Add last action if available
                        if (player.last_action) {
                            embed.addFields({ 
                                name: '⌚ Last Action', 
                                value: player.last_action.relative, 
                                inline: true 
                            });
                        }

                        // Add status if available
                        if (player.status?.description) {
                            embed.addFields({ 
                                name: '🔍 Status', 
                                value: player.status.description, 
                                inline: false 
                            });
                        }

                        const targetMessage = await channel.send({
                            embeds: [embed],
                            components: [row]
                        });
                        
                        // Track this message to delete it in the next cycle
                        availableTargetMessages.add(targetMessage.id);
                    }
                }
                
                // Create footer
                const footerMessage = await channel.send({
                    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
                });
                footerMessageId = footerMessage.id;
            }
        } catch (error) {
            console.error("Error fetching opponent faction data:", error);
        }
    }, CHECK_INTERVAL);
};

// Function to clear all messages in a channel
async function clearAllMessages(channel: TextChannel) {
    console.log(`Clearing all messages in channel: ${channel.name}`);
    
    try {
        // First, try the bulk delete method (limited to messages not older than 14 days)
        let messages = await channel.messages.fetch({ limit: 100 });
        
        while (messages.size > 0) {
            const messagesToDelete = messages.filter(msg => 
                // Make sure we only delete our bot's messages, not others
                msg.author.id === client.user?.id && 
                // Make sure not older than 14 days (Discord API limitation)
                Date.now() - msg.createdTimestamp < 1209600000
            );
            
            if (messagesToDelete.size === 0) break;
            
            if (messagesToDelete.size === 1) {
                // Delete single message
                const message = messagesToDelete.first();
                if (message) await message.delete();
            } else {
                // Bulk delete messages
                await channel.bulkDelete(messagesToDelete);
            }
            
            // Fetch the next batch of messages
            messages = await channel.messages.fetch({ limit: 100 });
            
            // If less than 100, we've reached the end
            if (messages.size < 100) break;
        }
        
        // For messages older than 14 days, we need to delete them one by one
        messages = await channel.messages.fetch({ limit: 100 });
        const oldMessages = messages.filter(msg => 
            msg.author.id === client.user?.id && 
            Date.now() - msg.createdTimestamp >= 1209600000
        );
        
        for (const [_, message] of oldMessages) {
            await message.delete();
            // Add a small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log("Channel cleared successfully");
    } catch (error) {
        console.error("Error clearing messages:", error);
    }
}

client.login(BOT_TOKEN);


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