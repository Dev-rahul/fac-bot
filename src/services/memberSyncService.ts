import { supabase } from '../database/supabaseClient';
import dotenv from 'dotenv';

dotenv.config();

// Constants
const API_KEY = process.env.TORN_API_KEY!;
const FACTION_ID = process.env.FACTION_ID || '41702';

// Member interface
interface FactionMember {
  id: number;
  name: string;
  level: number;
  days_in_faction: number;
  revive_setting: string;
  position: string;
  status?: string;
  last_action?: number;
}

/**
 * Fetch all faction members from Torn API
 */
async function fetchFactionMembers(): Promise<FactionMember[]> {
  try {
    console.log(`Fetching faction members for faction ${FACTION_ID}...`);

    // Make API request
    const url = `https://api.torn.com/faction/${FACTION_ID}?selections=basic&key=${API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Check for API error
    if (data.error) {
      throw new Error(`Torn API error: ${data.error.code} - ${data.error.error}`);
    }

    // Process members
    const members: FactionMember[] = [];
    
    // Extract members data from response
    if (data.members) {
      for (const [id, memberData] of Object.entries(data.members)) {
        const member = memberData as any;
        members.push({
          id: parseInt(id),
          name: member.name,
          level: member.level,
          days_in_faction: member.days_in_faction,
          revive_setting: member.revive || 'Unknown',
          position: member.position,
          status: member.status?.state || 'Unknown',
          last_action: member.last_action?.timestamp
        });
      }
      console.log(`Found ${members.length} faction members`);
    } else {
      console.warn('No members found in API response');
    }
    
    return members;
    
  } catch (error) {
    console.error('Error fetching faction members:', error);
    throw error;
  }
}

/**
 * Update faction members in the database
 */
export async function updateFactionMembers(): Promise<{
  success: boolean;
  count?: number;
  message: string;
  error?: any;
}> {
  try {
    console.log('Starting faction member sync...');
    
    // Fetch current members
    const members = await fetchFactionMembers();
    
    if (members.length === 0) {
      console.warn('No members fetched. Skipping database update.');
      return {
        success: false,
        message: 'No members found from API'
      };
    }
    
    // Prepare data for upsert
    const upsertData = members.map(member => ({
      id: member.id,
      name: member.name,
      level: member.level,
      days_in_faction: member.days_in_faction,
      revive_setting: member.revive_setting,
      position: member.position,
      status: member.status,
      last_action: member.last_action ? new Date(member.last_action * 1000).toISOString() : null,
      last_updated: new Date().toISOString()
    }));
    
    // Perform upsert operation (update if exists, insert if not)
    const { error, count } = await supabase
      .from('faction_members')
      .upsert(upsertData, {
        onConflict: 'id', // Conflict on primary key
        ignoreDuplicates: false // Update if exists
      })
      .select('count');
    
    if (error) {
      throw error;
    }
    
    console.log(`Successfully synced ${members.length} faction members`);
    
    // Get position statistics
    const { data: positionCounts, error: countError } = await supabase
      .from('faction_members')
      .select('position, count(*)')
      .group('position');
      
    const stats = !countError && positionCounts ? 
      positionCounts.map(p => `${p.position}: ${p.count}`).join(', ') : 
      'Statistics unavailable';
    
    return {
      success: true,
      count: members.length,
      message: `Successfully synced ${members.length} faction members. ${stats}`
    };
    
  } catch (error) {
    console.error('Failed to update faction members:', error);
    return {
      success: false,
      message: 'Failed to update faction members',
      error
    };
  }
}

/**
 * Run a manual sync of faction members
 */
export async function syncFactionMembers(): Promise<{
  success: boolean;
  message: string;
  error?: any;
}> {
  try {
    const result = await updateFactionMembers();
    console.log('Faction member sync completed:', result.message);
    return result;
  } catch (error) {
    console.error('Faction member sync failed:', error);
    return {
      success: false,
      message: 'Faction member sync failed with an exception',
      error
    };
  }
}

// Check if last sync was more than 23 hours ago
export async function shouldSync(): Promise<boolean> {
  try {
    // Get the most recent last_updated timestamp
    const { data, error } = await supabase
      .from('faction_members')
      .select('last_updated')
      .order('last_updated', { ascending: false })
      .limit(1);
    
    if (error || !data || data.length === 0) {
      // If there's an error or no data, we should sync
      return true;
    }
    
    const lastUpdate = new Date(data[0].last_updated);
    const now = new Date();
    const hoursSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60);
    
    // Return true if it's been more than 23 hours since last update
    return hoursSinceUpdate > 23;
  } catch (e) {
    console.error('Error checking last sync time:', e);
    // On error, play it safe and return true to trigger sync
    return true;
  }
}

// Export for use in command handlers and HTTP endpoints
export default syncFactionMembers;