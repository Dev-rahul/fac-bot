import { Message, EmbedBuilder } from 'discord.js';

// Types for member data from YATA API
interface YataMember {
    id: number;
    name: string;
    status: string;
    last_action: number;
    energy_share: number;
    energy: number;
    drug_cd: number;
    revive: boolean;
  }

interface YataResponse {
  members: Record<string, YataMember>;
  timestamp: number;
}

// Keep a cache of the last API response
let cachedResponse: YataResponse | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Generate and send a faction members status report
 * @param message Discord message that triggered the command
 * @param args Command arguments
 */
export async function handleFactionMembersReport(message: Message, args: string[]): Promise<void> {
  try {
    const progressMsg = await message.reply('Generating faction member status report...');
    
    // Fetch member data from YATA API
    const apiKey = process.env.TORN_API_KEY;
    if (!apiKey) {
      await progressMsg.edit('Error: TORN_API_KEY is not set in environment variables');
      return;
    }

    // Option to force refresh data
    const forceRefresh = args.includes('--refresh');
    
    // Get member data (either from cache or fresh)
    let memberData: YataResponse;
    
    if (!forceRefresh && cachedResponse && Date.now() - lastFetchTime < CACHE_DURATION) {
      memberData = cachedResponse;
      console.log('Using cached member data from memory');
    } else {
      memberData = await fetchMemberData(apiKey);
      
      // Update cache
      cachedResponse = memberData;
      lastFetchTime = Date.now();
      console.log('Fetched fresh member data from API');
    }
    
    if (!memberData || !memberData.members) {
      await progressMsg.edit('Error: Failed to fetch or parse member data');
      return;
    }

    // Generate the reports
    const { reportEmbed, textReport } = generateMemberReport(memberData);
    
    // Send the report embed
    await progressMsg.edit({ content: null, embeds: [reportEmbed] });
    
    // Send the copyable text report in chunks (Discord has 2000 char limit)
    const chunks = chunkString(textReport, 1900);
    for (const chunk of chunks) {
      await message.channel.send('```\n' + chunk + '\n```');
    }
    
  } catch (error) {
    console.error('Error generating member report:', error);
    await message.reply('An error occurred while generating the member report.');
  }
}

/**
 * Fetch member data from YATA API using Bun's fetch
 */
async function fetchMemberData(apiKey: string): Promise<YataResponse> {
  const response = await fetch(`https://yata.yt/api/v1/faction/members/?key=${apiKey}`);
  
  if (!response.ok) {
    throw new Error(`YATA API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data as YataResponse;
}

/**
 * Generate report from member data
 */
function generateMemberReport(data: YataResponse): { reportEmbed: EmbedBuilder, textReport: string } {
  const members = Object.values(data.members);
  
  // Filter for important statuses
  const understackedMembers = members.filter(m => 
    m.energy_share === 1 && m.energy < 750
  );

  const eShareDisabled = members.filter(m =>
    m.energy_share === -1  );
  
  const overdosedMembers = members.filter(m => 
    m.drug_cd > 30000
  );
  
  // Count by revive status
  const reviveReadyCount = members.filter(m => m.revive).length;
  const reviveNotReadyCount = members.filter(m => !m.revive).length;
  
  // Calculate online/offline counts
  const onlineCount = members.filter(m => 
    m.status === 'Online' || 
    (m.last_action < 15)
  ).length;
  
  // Create embed for Discord
  const reportEmbed = new EmbedBuilder()
    .setTitle('⚔️ Faction War Readiness Report')
    .setColor('#FF9900')
    .setDescription(`Report generated <t:${Math.floor(Date.now() / 1000)}:R>`)
    .addFields(
      { name: 'Total Members', value: members.length.toString(), inline: true },
      { name: 'Online/Active', value: `${onlineCount} (${Math.round(onlineCount / members.length * 100)}%)`, inline: true },
      { name: 'Understacked', value: understackedMembers.length.toString(), inline: true },
      { name: 'Overdosed', value: overdosedMembers.length.toString(), inline: true },
      { name: 'Revive Ready', value: `${reviveReadyCount} (${Math.round(reviveReadyCount / members.length * 100)}%)`, inline: true },
      { name: 'Revive Not Ready', value: `${reviveNotReadyCount}`, inline: true }
    )
    .setFooter({ text: 'Full report available in text format below' });
  
  // Create formatted text report for copying
  let textReport = '======== FACTION WAR READINESS REPORT ========\n';
  textReport += `Generated: ${new Date().toLocaleString()}\n`;
  textReport += `Total Members: ${members.length}\n\n`;
  
  // Understacked members section
  textReport += '===== UNDERSTACKED MEMBERS (e-share ON & e<750) =====\n';
  if (understackedMembers.length === 0) {
    textReport += 'None - All members properly stacked.\n';
  } else {
    textReport += formatMembersTable(understackedMembers);
  }
  textReport += '\n';
  
  // Overdosed members section
  textReport += '===== OVERDOSED MEMBERS (drug CD > 30k seconds) =====\n';
  if (overdosedMembers.length === 0) {
    textReport += 'None - No members currently overdosed.\n';
  } else {
    textReport += formatMembersTable(overdosedMembers);
  }
  textReport += '\n';

    // Energy Share Disabled section
    textReport += '=====  Energy Share Disabled Members =====\n';
    if (eShareDisabled.length === 0) {
      textReport += 'None - No members with eshare disabled.\n';
    } else {
      textReport += formatMembersTable(eShareDisabled);
    }
    textReport += '\n';
  
  return { reportEmbed, textReport };
}

/**
 * Format member data into a table string
 */
function formatMembersTable(members: YataMember[]): string {
  let table = 'ID        | NAME                           | ENERGY  | DRUG CD  | REVIVE  | STATUS\n';
  table += '---------- | ------------------------------ | ------- | -------- | ------- | --------\n';
  
  // Sort by energy (highest to lowest)
  const sortedMembers = [...members].sort((a, b) => 
    (b.energy || 0) - (a.energy || 0)
  );
  
  for (const member of sortedMembers) {
    const id = member.id.toString().padEnd(10);
    const name = member.name.substring(0, 30).padEnd(30);
    
    // Handle potential API changes by using optional chaining
    const energy = member.energy_share === 1 && member.energy
      ? member.energy.toString().padEnd(7) 
      : 'N/A'.padEnd(7);
    
    // Format drug CD as time if present
    const drugCD = member.drug_cd > 0
      ? formatDrugCD(member.drug_cd).padEnd(8)
      : 'None'.padEnd(8);
    
    const revive = member.revive 
      ? 'YES'.padEnd(7) 
      : 'NO'.padEnd(7);
    
    const status = member.status || 'Unknown';
    
    table += `${id} | ${name} | ${energy} | ${drugCD} | ${revive} | ${status}\n`;
  }
  
  return table;
}

/**
 * Format drug cooldown in minutes and seconds
 */
function formatDrugCD(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}:${minutes}`;
  }

/**
 * Split text into chunks of maximum size
 */
function chunkString(str: string, size: number): string[] {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    chunks.push(str.slice(i, i + size));
    i += size;
  }
  return chunks;
}

/**
 * Create a more compact text report for copying to clipboard
 */

export async function handleCompactReport(message: Message, args: string[] = []): Promise<void> {
    try {
      const progressMsg = await message.reply('Generating compact member report...');
      
      // Fetch member data
      const apiKey = process.env.TORN_API_KEY;
      if (!apiKey) {
        await progressMsg.edit('Error: TORN_API_KEY is not set in environment variables');
        return;
      }
  
      // Option to force refresh data
      const forceRefresh = args.includes('--refresh');
      
      // Get member data (either from cache or fresh)
      let memberData: YataResponse;
      
      if (!forceRefresh && cachedResponse && Date.now() - lastFetchTime < CACHE_DURATION) {
        memberData = cachedResponse;
      } else {
        memberData = await fetchMemberData(apiKey);
        
        // Update cache
        cachedResponse = memberData;
        lastFetchTime = Date.now();
      }
      
      if (!memberData || !memberData.members) {
        await progressMsg.edit('Error: Failed to fetch or parse member data');
        return;
      }
  
      // Generate compact report
      const members = Object.values(memberData.members);
      
      // First send the header with just a summary
      const summaryEmbed = new EmbedBuilder()
        .setTitle('⚔️ Faction War Readiness Report')
        .setColor('#FF9900')
        .setDescription(`Report generated <t:${Math.floor(Date.now() / 1000)}:R>`)
        .addFields(
          { name: 'Total Members', value: members.length.toString(), inline: true },
          { 
            name: 'Understacked', 
            value: members.filter(m => m.energy_share === 1 && m.energy < 750).length.toString(), 
            inline: true 
          },
          { 
            name: 'Overdosed', 
            value: members.filter(m => m.drug_cd > 30000).length.toString(), 
            inline: true 
          },
          { 
            name: 'Revive Ready', 
            value: members.filter(m => m.revive).length.toString(), 
            inline: true 
          }
        );
      
      await progressMsg.edit({ content: null, embeds: [summaryEmbed] });
      
      // Split members into batches to avoid Discord's character limit
      const BATCH_SIZE = 20; // Adjust this based on your needs
      const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));
      
      // Create batches of members
      for (let i = 0; i < sortedMembers.length; i += BATCH_SIZE) {
        const batch = sortedMembers.slice(i, i + BATCH_SIZE);
        
        // Create compact report header for this batch
        let compactReport = '```\n';
        compactReport += 'Member Name       | E | Energy | Drug CD | Revive | Status\n';
        compactReport += '----------------- | - | ------ | ------- | ------ | ------\n';
        
        for (const member of batch) {
          // Skip members with energy_share = -1 (private)
          if (member.energy_share === -1) continue;
          
          const name = member.name.substring(0, 16).padEnd(16);
          const eShare = member.energy_share === 1 ? 'Y' : 'N';
          
          // Handle potential API changes
          const energy = member.energy_share === 1 && member.energy
            ? member.energy
            : '-';
          
          const status = member.status?.substring(0, 8) || 'Unknown';
          
          // Create warning flags
          let flags = '';
          if (member.energy_share === 1 && member.energy < 750) flags += '⚠️'; // Understacked
          if (member.drug_cd > 30000) flags += '💊'; // Overdosed
          
          compactReport += `${name} | ${eShare} | ${String(energy).padEnd(6)} | ${formatCompactDrugCD(member.drug_cd).padEnd(7)} | ${member.revive ? 'Y' : 'N'} | ${status} ${flags}\n`;
        }
        
        // Add legend if this is the last batch
        if (i + BATCH_SIZE >= sortedMembers.length) {
          compactReport += '\n⚠️ = Understacked (<750E), 💊 = Overdosed\n';
        }
        
        compactReport += '```';
        
        // Send this batch report
        await message.channel.send(compactReport);
      }
      
    } catch (error) {
      console.error('Error generating compact report:', error);
      await message.reply('An error occurred while generating the compact report.');
    }
  }

/**
 * Format drug CD in minutes only for compact report
 */
function formatCompactDrugCD(seconds: number): string {
  if (seconds <= 0) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${minutes}`;
}

/**
 * Integrate this with your command handler
 */
export async function handleFactionCommand(message: Message, args: string[]): Promise<void> {
  const subCommand = args[0]?.toLowerCase();
  
  switch (subCommand) {
    case 'report':
    case 'status':
      await handleFactionMembersReport(message, args.slice(1));
      break;
    
    case 'compact':
      await handleCompactReport(message, args.slice(1));
      break;
      
    default:
      await message.reply(
        "Available faction commands:\n" +
        "`!faction report` - Generate a detailed faction member status report\n" +
        "`!faction compact` - Generate a compact, copyable report for war leaders\n" +
        "`!faction report --refresh` - Force refresh data from API"
      );
      break;
  }
}