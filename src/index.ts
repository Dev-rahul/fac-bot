import { Client, Events, GatewayIntentBits, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";


const MY_FACTION_ID = 41702; // Faction ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const API_KEY = process.env.TORN_API_KEY // API Key for authentication
const CHANNEL_ID = "1345081433139712051"; // Discord channel where messages will be sent
const CHECK_INTERVAL = 60_000; // 1-minute interval

const WAR_STATUS_URL = `https://api.torn.com/v2/faction/${MY_FACTION_ID}/wars`;


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

            if (soonToLeave.length > 0) {
                const channel = (await client.channels.fetch(CHANNEL_ID)) as TextChannel;
                
                // Send a header message for the new batch of alerts
                if (soonToLeave.length > 0) {
                    await channel.send({
                        content: `━━━━━━━━━━━━━━ 🏥 **HOSPITAL ALERTS** 🏥 ━━━━━━━━━━━━━━`
                    });
                }

                for (const player of soonToLeave) {
                    const minutesLeft = Math.ceil((player.status.until - now) / 60);
                    
                    // Format life status if available
                    const lifeStatus = player.life ? 
                        `\n**Health:** ${player.life.current}/${player.life.maximum} (${Math.floor((player.life.current/player.life.maximum)*100)}%)` : '';
                    
                    // Last action time
                    const lastActionInfo = player.last_action ? 
                        `\n**Last Action:** ${player.last_action.relative}` : '';
                        
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

                    // Create colorful divider with player info
                    await channel.send({
                        content: `══════════════════════════════════════════\n` +
                                `👤 **${player.name}** (Level ${player.level})\n` +
                                `⏰ Hospital exit in **${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}**\n` +
                                `🏢 Position: **${player.position}**\n` +
                                `📅 Faction loyalty: **${player.days_in_faction} days**${lifeStatus}${lastActionInfo}\n` +
                                `🔍 Status: *${player.status.description}*\n\n` +
                                `${player.is_revivable ? '✅ Can be revived' : '❌ Cannot be revived'}` +
                                `${player.has_early_discharge ? ' | ⚡ Has early discharge' : ''}\n\n` +
                                `**Click a button below:**`,
                        components: [row],
                    });
                }
                
                // Send a footer divider
                await channel.send({
                    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
                });
            }
        } catch (error) {
            console.error("Error fetching opponent faction data:", error);
        }
    }, CHECK_INTERVAL);
};


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