import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { getRecentWarReports, getWarReport, getWarContributions } from '../database/warReportRepository';

// Load environment variables
dotenv.config();

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

// Interface for war report summary data
export interface WarReportSummary {
  id?: number;
  war_id: number;
  start_time: number;
  end_time: number;
  opponent_id: number;
  opponent_name: string;
  our_score: number;
  their_score: number;
  winner: string;
  total_hits: number;
  total_assists: number;
  total_respect: number;
  created_at?: string;
}

// Interface for member contribution data
export interface MemberContributionData {
  id?: number;
  war_id: number;
  member_id: number;
  member_name: string;
  position: string;
  level: number;
  war_hits: number;
  under_respect_hits: number;
  non_war_hits: number;
  total_hits: number;
  hospitalizations: number;
  mugs: number;
  assists: number;
  draws: number;
  losses: number;
  respect: number;
  created_at?: string;
}

// Function to check if the database tables exist and create them if not
export async function ensureTables(): Promise<void> {
  try {
    // Check if the war_reports table exists
    const { error: warReportsError } = await supabase
      .from('war_reports')
      .select('id')
      .limit(1);

    if (warReportsError && warReportsError.code === '42P01') {
      console.log('Creating war_reports table...');
      // Create war_reports table
      await supabase.rpc('create_war_reports_table');
    }

    // Check if the member_contributions table exists
    const { error: contributionsError } = await supabase
      .from('member_contributions')
      .select('id')
      .limit(1);

    if (contributionsError && contributionsError.code === '42P01') {
      console.log('Creating member_contributions table...');
      // Create member_contributions table
      await supabase.rpc('create_member_contributions_table');
    }
  } catch (error) {
    console.error('Error ensuring tables exist:', error);
    throw error;
  }
}

// Function to save a war report summary
export async function saveWarReport(report: WarReportSummary): Promise<number | null> {
  try {
    // Ensure tables exist
    await ensureTables();
    
    // Check if the report already exists
    const { data: existingReport } = await supabase
      .from('war_reports')
      .select('id')
      .eq('war_id', report.war_id)
      .single();

    if (existingReport) {
      // Update existing report
      const { data, error } = await supabase
        .from('war_reports')
        .update(report)
        .eq('id', existingReport.id)
        .select('id')
        .single();

      if (error) {
        console.error('Error updating war report:', error);
        return null;
      }

      return data.id;
    } else {
      // Insert new report
      const { data, error } = await supabase
        .from('war_reports')
        .insert(report)
        .select('id')
        .single();

      if (error) {
        console.error('Error saving war report:', error);
        return null;
      }

      return data.id;
    }
  } catch (error) {
    console.error('Error saving war report:', error);
    return null;
  }
}

// Function to save member contributions
// Update the saveMemberContributions function with better error handling

export async function saveMemberContributions(contributions: MemberContributionData[]): Promise<boolean> {
    try {
      // Ensure tables exist
      await ensureTables();
  
      // Process contributions in batches to avoid request size limits
      const batchSize = 20; // Reduced batch size
      for (let i = 0; i < contributions.length; i += batchSize) {
        const batch = contributions.slice(i, i + batchSize);
        
        console.log(`Processing batch ${Math.floor(i/batchSize) + 1} of ${Math.ceil(contributions.length/batchSize)}, with ${batch.length} records`);
        
        // Create a batch of upsert operations
        const { data, error } = await supabase
          .from('member_contributions')
          .upsert(
            batch.map(contribution => ({
              war_id: contribution.war_id,
              member_id: contribution.member_id,
              member_name: contribution.member_name,
              position: contribution.position || 'Unknown',
              level: contribution.level || 0,
              war_hits: contribution.war_hits || 0,
              under_respect_hits: contribution.under_respect_hits || 0,
              non_war_hits: contribution.non_war_hits || 0,
              total_hits: contribution.total_hits || 0,
              hospitalizations: contribution.hospitalizations || 0,
              mugs: contribution.mugs || 0,
              assists: contribution.assists || 0,
              draws: contribution.draws || 0,
              losses: contribution.losses || 0,
              respect: contribution.respect || 0
            })),
            { 
              onConflict: 'war_id,member_id',
              ignoreDuplicates: false
            }
          );
  
        if (error) {
          // Log detailed error information
          console.error('Error details:', {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code
          });
          
          // Log a sample of the data that caused the error
          if (batch.length > 0) {
            console.error('Sample data causing error:', JSON.stringify(batch[0], null, 2));
          }
        }
      }
  
      return true;
    } catch (error) {
      // Enhanced error logging
      console.error('Caught exception in saveMemberContributions:', error);
      if (error instanceof Error) {
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
      return false;
    }
  }

// Function to get recent war reports
export async function getRecentWarReports(limit: number = 10): Promise<WarReportSummary[]> {
  try {
    const { data, error } = await supabase
      .from('war_reports')
      .select('*')
      .order('end_time', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching recent war reports:', error);
      return [];
    }

    return data;
  } catch (error) {
    console.error('Error fetching recent war reports:', error);
    return [];
  }
}

// Function to get a specific war report
export async function getWarReport(warId: number): Promise<WarReportSummary | null> {
  try {
    const { data, error } = await supabase
      .from('war_reports')
      .select('*')
      .eq('war_id', warId)
      .single();

    if (error) {
      console.error('Error fetching war report:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error fetching war report:', error);
    return null;
  }
}

// Function to get member contributions for a war
export async function getWarContributions(warId: number): Promise<MemberContributionData[]> {
  try {
    const { data, error } = await supabase
      .from('member_contributions')
      .select('*')
      .eq('war_id', warId);

    if (error) {
      console.error('Error fetching war contributions:', error);
      return [];
    }

    return data;
  } catch (error) {
    console.error('Error fetching war contributions:', error);
    return [];
  }
}

// Get the 10 most recent war reports
async function displayRecentReports() {
  const reports = await getRecentWarReports(10);
  console.log(`Found ${reports.length} recent reports`);
  
  reports.forEach(report => {
    console.log(`War ID: ${report.war_id}, Opponent: ${report.opponent_name}, Result: ${report.our_score}-${report.their_score}`);
  });
}

// Get a specific war report by ID
async function displayWarReport(warId: number) {
  const report = await getWarReport(warId);
  
  if (report) {
    console.log(`Found report for War ID: ${report.war_id}`);
    console.log(`Opponent: ${report.opponent_name}`);
    console.log(`Result: ${report.our_score}-${report.their_score} (${report.winner} won)`);
    console.log(`Total hits: ${report.total_hits}`);
  } else {
    console.log(`No report found for War ID: ${warId}`);
  }
}

// Get member contributions for a specific war
async function displayWarContributions(warId: number) {
  const contributions = await getWarContributions(warId);
  
  console.log(`Found ${contributions.length} member contributions for War ID: ${warId}`);
  
  // Sort by war hits (descending)
  const sortedContributions = [...contributions].sort((a, b) => b.war_hits - a.war_hits);
  
  // Display top contributors
  console.log("Top Contributors:");
  sortedContributions.slice(0, 5).forEach((member, index) => {
    console.log(`${index + 1}. ${member.member_name}: ${member.war_hits} hits, ${member.assists} assists, ${member.respect.toFixed(2)} respect`);
  });
}