import { Message, AttachmentBuilder, EmbedBuilder } from "discord.js";
import { API_KEY } from "./warReportTypes";

// Add imports for database operations
import { 
  saveWarReport, 
  saveMemberContributions, 
  getWarReport, 
  getWarContributions, 
  getRecentWarReports,
  WarReportSummary,
  MemberContributionData 
} from '../database/warReportRepository';

// Interfaces for API responses
interface RankedWarFaction {
    id: number;
    name: string;
    score: number;
    chain: number;
}

interface RankedWar {
    id: number;
    start: number;
    end: number;
    target: number;
    winner: number;
    factions: RankedWarFaction[];
}

interface RankedWarsResponse {
    rankedwars: RankedWar[];
    _metadata: {
        prev: string | null;
        next: string | null;
    };
}

interface AttackerDefender {
    id: number;
    faction_id: number | null;
}

interface Attack {
    id: number;
    code: string;
    started: number;
    ended: number;
    attacker: AttackerDefender | null;
    defender: AttackerDefender | null;
    result: string; // "Attacked", "Hospitalized", "Mugged", "Assist", etc.
    respect_gain: number;
    respect_loss: number;
}

interface AttacksResponse {
    attacks: Attack[];
    _metadata: {
        links: {
            prev: string | null;
            next: string | null;
        };
    };
}

interface FactionMember {
    id: number;
    name: string;
    level: number;
    days_in_faction: number;
    last_action: {
        status: string;
        timestamp: number;
        relative: string;
    };
    status: {
        description: string;
        details: string | null;
        state: string;
        until: number | null;
    };
    position: string;
}

interface FactionMembersResponse {
    members: FactionMember[];
}

interface MemberContribution {
    id: number;
    name: string;
    level?: number;
    position?: string;
    attacks: number;           // Total attacks
    hospitalizations: number;  // Hospital results
    mugs: number;              // Mugging results
    assists: number;           // Assists
    loses: number;             // Failed attacks
    draw: number;              // draw attacks
    respect: number;           // Total respect gained
    warHits: number;           // Attacks against war opponent
    underRespectHits: number;  // Attacks against war opponent but under respect
    nonWarHits: number;        // Attacks against others
}

interface WarReportData {
    warId: number;
    startTime: number;
    endTime: number;
    opponent: {
        id: number;
        name: string;
    };
    result: {
        winner: string;
        ourScore: number;
        theirScore: number;
    };
    contributions: Map<number, MemberContribution>; // Map of member ID to their contributions
    totalHits: number;
    totalAssists: number;
    totalRespect: number;
}

// Our faction ID constant
const OUR_FACTION_ID = 41702;
const FACTION_NAME = "Fatality";
const minRespect = process.env.MIN_RESPECT ? parseInt(process.env.MIN_RESPECT) : 0;

/**
 * Fetches current faction member data
 */
async function fetchFactionMembers(): Promise<Map<number, FactionMember>> {
    try {
        const url = `https://api.torn.com/v2/faction/members?striptags=true`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `ApiKey ${API_KEY}`,
                'accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json() as FactionMembersResponse;
        
        // Convert to a map for easy lookup by ID
        const memberMap = new Map<number, FactionMember>();
        if (data.members) {
            for (const member of data.members) {
                memberMap.set(member.id, member);
            }
        }
        
        return memberMap;
    } catch (error) {
        console.error("Error fetching faction members:", error);
        return new Map();
    }
}

/**
 * Fetches war data from the API
 * @param warId Optional ID of specific war to fetch
 * @returns The war data
 */
async function fetchWarData(warId?: number): Promise<RankedWar | null> {
    try {
        const url = `https://api.torn.com/v2/faction/${OUR_FACTION_ID}/rankedwars`;
        const response = await fetch(url, {
            headers: {
                'Authorization': `ApiKey ${API_KEY}`,
                'accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json() as RankedWarsResponse;
        
        if (!data.rankedwars || data.rankedwars.length === 0) {
            return null;
        }
        
        // If warId is provided, find that specific war
        if (warId) {
            const specificWar = data.rankedwars.find(war => war.id === warId);
            return specificWar || null;
        }
        
        // Otherwise return the most recent war (first in the array)
        return data.rankedwars[0];
    } catch (error) {
        console.error("Error fetching war data:", error);
        return null;
    }
}

/**
 * Fetches attack logs within a time range with pagination
 */
async function fetchAllAttackLogs(startTime: number, endTime: number): Promise<Attack[]> {
    try {
        const allAttacks: Attack[] = [];
        let hasMore = true;
        let currentUrl = `https://api.torn.com/v2/faction/attacksfull?limit=1000&sort=DESC&to=${endTime}&from=${startTime}`;
                
        // Keep fetching until we've got all attacks
        while (hasMore) {
            console.log(`Fetching: ${currentUrl}`);
            
            const response = await fetch(currentUrl, {
                headers: {
                    'Authorization': `ApiKey ${API_KEY}`,
                    'accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json() as AttacksResponse;
            
            if (!data.attacks || data.attacks.length === 0) {
                hasMore = false;
                continue;
            }
            
            // Process and add attacks to our collection
            allAttacks.push(...data.attacks);
            console.log(`Fetched ${data.attacks.length} attacks. Total so far: ${allAttacks.length}`);
            
            // Check if there's more data to fetch - since we're using DESC order,
            // we need to look for the prev link (which points to earlier attacks)
            if (!data._metadata?.links?.prev) {
                hasMore = false;
            } else {
                // Use the prev link for earlier attacks
                currentUrl = data._metadata.links.prev;
                
                // Add API key to the URL if needed
                if (!currentUrl.includes('key=')) {
                    currentUrl += currentUrl.includes('?') ? '&' : '?';
                    currentUrl += `key=${API_KEY}`;
                }
            }
            
            // Avoid rate limiting - add a small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`Completed fetching all attack logs. Total: ${allAttacks.length}`);
        return allAttacks;
    } catch (error) {
        console.error("Error fetching attack logs:", error);
        return [];
    }
}

/**
 * Processes attack data into member contributions
 */
/**
 * Processes attack data into member contributions and ensures all faction members are included
 */
function processAttacks(
    attacks: Attack[], 
    opponentFactionId: number,
    members: Map<number, FactionMember>
): {
    contributions: Map<number, MemberContribution>;
    totalHits: number;
    totalAssists: number;
    totalRespect: number;
} {
    const contributions = new Map<number, MemberContribution>();
    let totalHits = 0;
    let totalAssists = 0;
    let totalRespect = 0;
    
    // First, initialize contributions for ALL faction members
    // This ensures everyone is included even if they made no attacks
    for (const [memberId, member] of members) {
        contributions.set(memberId, {
            id: memberId,
            name: member.name,
            level: member.level,
            position: member.position,
            attacks: 0,
            hospitalizations: 0,
            mugs: 0,
            assists: 0,
            loses: 0,
            draw: 0,
            respect: 0,
            warHits: 0,
            underRespectHits: 0,
            nonWarHits: 0
        });
    }
    
    // Process all attacks
    for (const attack of attacks) {
        // Skip if attacker info is missing
        if (!attack.attacker || attack.attacker.faction_id !== OUR_FACTION_ID) {
            continue;
        }
        
        // Get the attacker ID from the attacker object
        const memberId = attack.attacker.id;
        const member = members.get(memberId);
        
        // Initialize member data if not already done
        // This handles cases where an attacker might not be in the current member list
        // (e.g., they left the faction after the war)
        if (!contributions.has(memberId)) {
            contributions.set(memberId, {
                id: memberId,
                name: member ? member.name : `Unknown [${memberId}]`,
                level: member ? member.level : undefined,
                position: member ? member.position : undefined,
                attacks: 0,
                hospitalizations: 0,
                mugs: 0,
                assists: 0,
                loses: 0,
                draw: 0,
                respect: 0,
                warHits: 0,
                underRespectHits: 0,
                nonWarHits: 0
            });
        }
        
        const memberContribution = contributions.get(memberId)!;
        
        // Record the respect gain for all attacks
        memberContribution.respect += attack.respect_gain || 0;
        totalRespect += attack.respect_gain || 0;
        
        // Categorize by result type
        const resultLower = attack.result?.toLowerCase() || '';
        
        // Check if target is opponent faction
        const isAgainstOpponent = attack.defender?.faction_id === opponentFactionId;
        
        // Count total attacks regardless of target
        memberContribution.attacks++;
        
        // Handle assists separately
        if (resultLower.includes('assist')) {
            memberContribution.assists++;
            
            // Only count assists against opponent faction for total assists
            if (isAgainstOpponent) {
                totalAssists++;
            }
            continue;
        }
        
        // Handle successful attacks and hospitalizations
        if (resultLower === 'attacked' || resultLower === "hospitalized") {
            // War hits - against opponent faction
            if (isAgainstOpponent) {
                attack.respect_gain > (minRespect || 0) ? memberContribution.warHits++ : memberContribution.underRespectHits++;
                totalHits++;
            }
            // Non-war hits - against anyone else
            else {
                memberContribution.nonWarHits++;
            }
            
            // Track hospitalizations separately regardless of target
            if (resultLower === "hospitalized") {
                memberContribution.hospitalizations++;
            }
        }
        // Track other result types but don't count as war/non-war hits
        else if (resultLower === "mugged") {
            memberContribution.mugs++;
        }
        else if (resultLower === "stalemate" || resultLower === "timeout") {
            memberContribution.draw++;
        }
        else if (resultLower.includes('lost') || 
                resultLower.includes('special') || 
                resultLower.includes('arrested') || 
                resultLower.includes('interrupt')) {
            memberContribution.loses++;
        }
    }
    
    return { contributions, totalHits, totalAssists, totalRespect };
}

/**
 * Generates a war report
 */
async function generateWarReport(warId?: number): Promise<WarReportData | null> {
    // Fetch war data
    const war = await fetchWarData(warId);
    if (!war) {
        return null;
    }
    
    // Get our faction's details and opponent's details
    const ourFaction = war.factions.find(f => f.id === OUR_FACTION_ID);
    const opponentFaction = war.factions.find(f => f.id !== OUR_FACTION_ID);
    
    if (!ourFaction || !opponentFaction) {
        return null;
    }
    
    // Determine the winner
    const didWeWin = war.winner === OUR_FACTION_ID;
    
    // Fetch member data for name resolution
    const members = await fetchFactionMembers();
    
    // Fetch all attack logs during the war period
    console.log(`Fetching attack logs from ${war.start} to ${war.end}`);
    const attackLogs = await fetchAllAttackLogs(war.start, war.end);
    console.log(`Retrieved ${attackLogs.length} attack logs`);
    
    // Process attack logs into member contributions
    const { contributions, totalHits, totalAssists, totalRespect } = 
        processAttacks(attackLogs, opponentFaction.id, members);
    
    return {
        warId: war.id,
        startTime: war.start,
        endTime: war.end,
        opponent: {
            id: opponentFaction.id,
            name: opponentFaction.name
        },
        result: {
            winner: didWeWin ? FACTION_NAME : opponentFaction.name,
            ourScore: ourFaction.score,
            theirScore: opponentFaction.score
        },
        contributions,
        totalHits,
        totalAssists,
        totalRespect
    };
}

/**
 * Exports the war report as a CSV
 */
function generateWarReportCSV(report: WarReportData): string {
    const headers = [
        'Member ID', 
        'Member Name',
        'Position',
        'Level',
        'War Hits', 
        'Under Respect Hits', 
        'Non-War Hits', 
        'Total Hits', 
        'Hospitalizations',
        'Mugs',
        'Assists', 
        'Draws',
        'Losses',
        'Respect Gained'
    ].join(',');
    
    const contributionsArray = Array.from(report.contributions.values())
        // Sort by war hits (descending)
        .sort((a, b) => b.warHits - a.warHits);
    
    const rows = contributionsArray.map(member => [
        member.id,
        `"${member.name}"`, // Quote the name to handle commas
        `"${member.position || 'Unknown'}"`,
        member.level || '',
        member.warHits,
        member.underRespectHits,
        member.nonWarHits,
        member.attacks,
        member.hospitalizations,
        member.mugs,
        member.assists,
        member.draw,
        member.loses,
        member.respect.toFixed(2)
    ].join(','));
    
    return [headers, ...rows].join('\n');
}

/**
 * Command handler for generating war reports
 */
export async function handleGenerateWarReport(message: Message, args: string[]): Promise<void> {
    try {
        // Check if a specific war ID was provided
        let warId: number | undefined = undefined;
        
        if (args.length > 0 && !isNaN(parseInt(args[0]))) {
            warId = parseInt(args[0]);
        }
        
        // Let the user know we're working on it
        const progressMsg = await message.reply(
            warId 
                ? `Generating war report for war ID: ${warId}...` 
                : "Generating war report for the most recent war..."
        );
        
        // Generate the report
        await progressMsg.edit("Fetching war data...");
        const report = await generateWarReport(warId);
        
        if (!report) {
            await progressMsg.edit("Failed to generate war report. No war data found.");
            return;
        }
        
        await progressMsg.edit("Processing attack data...");
        
        // Generate CSV
        const csv = generateWarReportCSV(report);
        const buffer = Buffer.from(csv, 'utf-8');
        
        // Format dates for filename
        const startDate = new Date(report.startTime * 1000).toISOString().split('T')[0];
        const endDate = new Date(report.endTime * 1000).toISOString().split('T')[0];
        
        // Create attachment
        const attachment = new AttachmentBuilder(buffer, {
            name: `war-report-${report.warId}-${startDate}-to-${endDate}.csv`
        });
        
        // Create an embed with summary information
        const contributionsArray = Array.from(report.contributions.values());
        
        // Save report to database
        await progressMsg.edit("Saving report to database...");
        try {
            // Save war report summary
            const warReportSummary: WarReportSummary = {
                war_id: report.warId,
                start_time: report.startTime,
                end_time: report.endTime,
                opponent_id: report.opponent.id,
                opponent_name: report.opponent.name,
                our_score: report.result.ourScore,
                their_score: report.result.theirScore,
                winner: report.result.winner,
                total_hits: report.totalHits,
                total_assists: report.totalAssists,
                total_respect: report.totalRespect
            };
            
            await saveWarReport(warReportSummary);
            
            // Save member contributions
            const memberContributions: MemberContributionData[] = contributionsArray.map(member => ({
                war_id: report.warId,
                member_id: member.id,
                member_name: member.name,
                position: member.position || 'Unknown',
                level: member.level || 0,
                war_hits: member.warHits || 0,
                under_respect_hits: member.underRespectHits || 0,
                non_war_hits: member.nonWarHits || 0,
                total_hits: member.attacks || 0,
                hospitalizations: member.hospitalizations || 0,
                mugs: member.mugs || 0,
                assists: member.assists || 0,
                draws: member.draw || 0,
                losses: member.loses || 0,
                respect: member.respect || 0
            }));
            
            await saveMemberContributions(memberContributions);
            console.log(`Saved war report ${report.warId} to database`);
        } catch (dbError) {
            console.error("Error saving to database:", dbError);
            // Continue with report generation even if database save fails
        }
        
        const embed = new EmbedBuilder()
            .setTitle(`⚔️ War Report: ${FACTION_NAME} vs ${report.opponent.name}`)
            .setColor(report.result.winner === FACTION_NAME ? '#00FF00' : '#FF0000')
            .setDescription(
                `**War ID:** ${report.warId}\n` +
                `**Period:** ${new Date(report.startTime * 1000).toLocaleString()} to ${new Date(report.endTime * 1000).toLocaleString()}\n` +
                `**Result:** ${report.result.ourScore} - ${report.result.theirScore} (${report.result.winner} won)\n\n` +
                `**Total War Hits:** ${report.totalHits}\n` +
                `**Total Assists:** ${report.totalAssists}\n` +
                `**Total Respect:** ${report.totalRespect.toFixed(2)}\n` +
                `**Total Members Participated:** ${contributionsArray.length}`
            )
            .setFooter({ text: 'Detailed report available in the CSV file' });
            
        // Add top 5 contributors
        const topContributors = contributionsArray
            .sort((a, b) => b.warHits - a.warHits)
            .slice(0, 5);
            
        if (topContributors.length > 0) {
            const topContributorsField = topContributors.map(c => 
                `**${c.name}**: ${c.warHits} war hits, ${c.assists} assists, ${c.respect.toFixed(2)} respect`
            ).join('\n');
            
            embed.addFields({
                name: '👑 Top Contributors',
                value: topContributorsField
            });
        }
        
        // Add hospital stats
        const totalHospitalizations = contributionsArray.reduce((sum, c) => sum + c.hospitalizations, 0);
        const totalMugs = contributionsArray.reduce((sum, c) => sum + c.mugs, 0);
        
        embed.addFields({
            name: '🏥 Hospital Stats',
            value: `Hospitalizations: ${totalHospitalizations}\nMuggings: ${totalMugs}`
        });

        // Add a note in the embed for inactive members
        const inactiveMembers = contributionsArray.filter(m => m.attacks === 0).length;
        if (inactiveMembers > 0) {
            embed.addFields({
                name: '⚠️ Inactive Members',
                value: `${inactiveMembers} faction members did not participate in this war.`
            });
        }
        
        // Send the report
        await progressMsg.edit({
            content: "War report generated successfully!",
            embeds: [embed],
            files: [attachment]
        });
        
    } catch (error) {
        console.error("Error generating war report:", error);
        await message.reply("An error occurred while generating the war report.");
    }
}

/**
 * Export the command handler
 */
export function exportHandleGenerateWarReport() {
    return handleGenerateWarReport;
}

// Add a new function to handle historical reports
export async function handleHistoricalReports(message: Message, args: string[]): Promise<void> {
    try {
        // Check for specific war ID
        if (args.length > 0 && !isNaN(parseInt(args[0]))) {
            const warId = parseInt(args[0]);
            await sendHistoricalReport(message, warId);
            return;
        }
        
        // No war ID specified, show list of available reports
        const recentReports = await getRecentWarReports(10);
        
        if (recentReports.length === 0) {
            await message.reply("No war reports found in the database.");
            return;
        }
        
        const embed = new EmbedBuilder()
            .setTitle('📊 Recent War Reports')
            .setDescription('Use `!warreport history <warId>` to view a specific report')
            .setColor('#0099ff');
            
        for (const report of recentReports) {
            const startDate = new Date(report.start_time * 1000).toLocaleDateString();
            const endDate = new Date(report.end_time * 1000).toLocaleDateString();
            
            embed.addFields({
                name: `War ID: ${report.war_id} (${startDate} - ${endDate})`,
                value: `${FACTION_NAME} vs ${report.opponent_name}: ${report.our_score} - ${report.their_score} (${report.winner} won)`
            });
        }
        
        await message.reply({ embeds: [embed] });
    } catch (error) {
        console.error("Error retrieving historical reports:", error);
        await message.reply("An error occurred while retrieving historical reports.");
    }
}

// Helper function to send a specific historical report
async function sendHistoricalReport(message: Message, warId: number): Promise<void> {
    try {
        // Get the war report from the database
        const report = await getWarReport(warId);
        
        if (!report) {
            await message.reply(`No report found for War ID: ${warId}`);
            return;
        }
        
        // Get the member contributions
        const contributions = await getWarContributions(warId);
        
        if (contributions.length === 0) {
            await message.reply(`Found war report for ID: ${warId}, but no member contributions data is available.`);
            return;
        }
        
        // Create CSV
        const headers = [
            'Member ID', 
            'Member Name',
            'Position',
            'Level',
            'War Hits', 
            'Under Respect Hits', 
            'Non-War Hits', 
            'Total Hits', 
            'Hospitalizations',
            'Mugs',
            'Assists', 
            'Draws',
            'Losses',
            'Respect Gained'
        ].join(',');
        
        const sortedContributions = [...contributions].sort((a, b) => b.war_hits - a.war_hits);
        
        const rows = sortedContributions.map(member => [
            member.member_id,
            `"${member.member_name}"`,
            `"${member.position}"`,
            member.level,
            member.war_hits,
            member.under_respect_hits,
            member.non_war_hits,
            member.total_hits,
            member.hospitalizations,
            member.mugs,
            member.assists,
            member.draws,
            member.losses,
            member.respect.toFixed(2)
        ].join(','));
        
        const csv = [headers, ...rows].join('\n');
        const buffer = Buffer.from(csv, 'utf-8');
        
        // Format dates for filename
        const startDate = new Date(report.start_time * 1000).toISOString().split('T')[0];
        const endDate = new Date(report.end_time * 1000).toISOString().split('T')[0];
        
        // Create attachment
        const attachment = new AttachmentBuilder(buffer, {
            name: `war-report-${report.war_id}-${startDate}-to-${endDate}.csv`
        });
        
        // Create embed
        const embed = new EmbedBuilder()
            .setTitle(`⚔️ War Report: ${FACTION_NAME} vs ${report.opponent_name}`)
            .setColor(report.winner === FACTION_NAME ? '#00FF00' : '#FF0000')
            .setDescription(
                `**War ID:** ${report.war_id}\n` +
                `**Period:** ${new Date(report.start_time * 1000).toLocaleString()} to ${new Date(report.end_time * 1000).toLocaleString()}\n` +
                `**Result:** ${report.our_score} - ${report.their_score} (${report.winner} won)\n\n` +
                `**Total War Hits:** ${report.total_hits}\n` +
                `**Total Assists:** ${report.total_assists}\n` +
                `**Total Respect:** ${report.total_respect.toFixed(2)}\n` +
                `**Total Members Participated:** ${contributions.length}`
            )
            .setFooter({ text: `Retrieved from database • Generated: ${new Date(report.created_at!).toLocaleString()}` });
            
        // Add top 5 contributors
        const topContributors = sortedContributions.slice(0, 5);
        if (topContributors.length > 0) {
            const topContributorsField = topContributors.map(c => 
                `**${c.member_name}**: ${c.war_hits} war hits, ${c.assists} assists, ${c.respect.toFixed(2)} respect`
            ).join('\n');
            
            embed.addFields({
                name: '👑 Top Contributors',
                value: topContributorsField
            });
        }
        
        // Add hospital stats
        const totalHospitalizations = contributions.reduce((sum, c) => sum + c.hospitalizations, 0);
        const totalMugs = contributions.reduce((sum, c) => sum + c.mugs, 0);
        
        embed.addFields({
            name: '🏥 Hospital Stats',
            value: `Hospitalizations: ${totalHospitalizations}\nMuggings: ${totalMugs}`
        });
        
        await message.reply({
            content: "Here's the archived war report:",
            embeds: [embed],
            files: [attachment]
        });
    } catch (error) {
        console.error("Error retrieving war report:", error);
        await message.reply("An error occurred while retrieving the war report.");
    }
}

// Add this function to display historic reports
export async function handleDisplayHistoricReports(message: Message, args: string[]): Promise<void> {
  try {
    // Check for specific war ID
    if (args.length > 0 && !isNaN(parseInt(args[0]))) {
      const warId = parseInt(args[0]);
      const report = await getWarReport(warId);
      
      if (!report) {
        await message.reply(`No report found for War ID: ${warId}`);
        return;
      }
      
      // Get member contributions
      const contributions = await getWarContributions(warId);
      
      // Create an embed to display the report
      const embed = new EmbedBuilder()
        .setTitle(`⚔️ War Report: ${FACTION_NAME} vs ${report.opponent_name}`)
        .setColor(report.winner === FACTION_NAME ? '#00FF00' : '#FF0000')
        .setDescription(
          `**War ID:** ${report.war_id}\n` +
          `**Period:** ${new Date(report.start_time * 1000).toLocaleString()} to ${new Date(report.end_time * 1000).toLocaleString()}\n` +
          `**Result:** ${report.our_score} - ${report.their_score} (${report.winner} won)\n\n` +
          `**Total War Hits:** ${report.total_hits}\n` +
          `**Total Assists:** ${report.total_assists}\n` +
          `**Total Respect:** ${report.total_respect.toFixed(2)}\n` +
          `**Total Members Participated:** ${contributions.length}`
        );
      
      // Add top contributors
      const topContributors = [...contributions]
        .sort((a, b) => b.war_hits - a.war_hits)
        .slice(0, 5);
      
      if (topContributors.length > 0) {
        const topContributorsField = topContributors.map(c => 
          `**${c.member_name}**: ${c.war_hits} war hits, ${c.assists} assists, ${c.respect.toFixed(2)} respect`
        ).join('\n');
        
        embed.addFields({
          name: '👑 Top Contributors',
          value: topContributorsField
        });
      }
      
      await message.reply({
        embeds: [embed]
      });
      
    } else {
      // Display list of available reports
      const reports = await getRecentWarReports(10);
      
      if (reports.length === 0) {
        await message.reply('No war reports found in the database.');
        return;
      }
      
      const embed = new EmbedBuilder()
        .setTitle('📊 Available War Reports')
        .setDescription('Use `!warreport display <warId>` to view details of a specific report')
        .setColor('#0099ff');
      
      reports.forEach(report => {
        const startDate = new Date(report.start_time * 1000).toLocaleDateString();
        const endDate = new Date(report.end_time * 1000).toLocaleDateString();
        
        embed.addFields({
          name: `War ID: ${report.war_id} (${startDate} - ${endDate})`,
          value: `${FACTION_NAME} vs ${report.opponent_name}: ${report.our_score} - ${report.their_score} (${report.winner} won)`
        });
      });
      
      await message.reply({
        embeds: [embed]
      });
    }
  } catch (error) {
    console.error('Error displaying historic reports:', error);
    await message.reply('An error occurred while retrieving war report data.');
  }
}