import { supabase } from './supabaseClient';

// Type definitions
export interface WarPayout {
  id?: number;
  war_id: number;
  total_rw_cash: number;
  payout_percentage: number;
  total_payout: number;
  reserved_amount: number;
  total_points: number;
  payment_per_point: number;
  created_at?: string;
  updated_at?: string;
}

export interface WarMemberPayout {
  id?: number;
  payout_id: number;
  member_id: number;
  member_name: string;
  war_hits: number;
  under_respect_hits: number;
  non_war_hits: number;
  assists: number;
  points: number;
  payment_amount: number;
  paid: boolean;
  paid_at?: string | null;
  paid_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Save a war payout summary and return its ID
 */
export async function saveWarPayout(payout: WarPayout): Promise<number | null> {
  try {
    // Check if a payout for this war already exists
    const { data: existingPayout, error: checkError } = await supabase
      .from('war_payouts')
      .select('id')
      .eq('war_id', payout.war_id)
      .maybeSingle();
    
    if (checkError) throw checkError;
    
    // If a payout already exists, update it
    if (existingPayout?.id) {
      const { error: updateError } = await supabase
        .from('war_payouts')
        .update({
          ...payout,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingPayout.id);
        
      if (updateError) throw updateError;
      return existingPayout.id;
    }
    
    // Otherwise insert a new payout
    const { data, error } = await supabase
      .from('war_payouts')
      .insert({
        ...payout,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();
    
    if (error) throw error;
    return data.id;
    
  } catch (error) {
    console.error("Error saving war payout:", error);
    return null;
  }
}

/**
 * Save member payouts for a war
 */
export async function saveWarMemberPayouts(
  payoutId: number,
  memberPayouts: Omit<WarMemberPayout, 'payout_id' | 'id'>[]
): Promise<boolean> {
  try {
    // Process the payouts in batches of 50 to avoid potential payload size issues
    const batchSize = 50;
    for (let i = 0; i < memberPayouts.length; i += batchSize) {
      const batch = memberPayouts.slice(i, i + batchSize).map(payout => ({
        ...payout,
        payout_id: payoutId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }));
      
      const { error } = await supabase
        .from('war_member_payouts')
        .upsert(batch, {
          onConflict: 'payout_id,member_id',
          ignoreDuplicates: false
        });
        
      if (error) throw error;
    }
    
    return true;
  } catch (error) {
    console.error("Error saving war member payouts:", error);
    return false;
  }
}

/**
 * Get a payout by war ID
 */
export async function getPayoutByWarId(warId: number): Promise<{
  summary: WarPayout | null;
  members: WarMemberPayout[];
}> {
  try {
    // Get the payout summary
    const { data: summaryData, error: summaryError } = await supabase
      .from('war_payouts')
      .select('*')
      .eq('war_id', warId)
      .single();
      
    if (summaryError) {
      if (summaryError.code === 'PGRST116') {
        // No data found, return empty result
        return { summary: null, members: [] };
      }
      throw summaryError;
    }
    
    if (!summaryData) {
      return { summary: null, members: [] };
    }
    
    // Get the member payouts
    const { data: membersData, error: membersError } = await supabase
      .from('war_member_payouts')
      .select('*')
      .eq('payout_id', summaryData.id)
      .order('payment_amount', { ascending: false });
      
    if (membersError) throw membersError;
    
    return {
      summary: summaryData,
      members: membersData || []
    };
    
  } catch (error) {
    console.error("Error getting payout by war ID:", error);
    return { summary: null, members: [] };
  }
}

/**
 * Update payment status for multiple members
 */
export async function updatePaymentStatus(
  payoutId: number,
  memberUpdates: { memberId: number; paid: boolean; paidBy?: string }[]
): Promise<boolean> {
  try {
    // Process updates in batches
    const batchSize = 25;
    for (let i = 0; i < memberUpdates.length; i += batchSize) {
      const batch = memberUpdates.slice(i, i + batchSize);
      
      // Process each update
      for (const update of batch) {
        const { error } = await supabase
          .from('war_member_payouts')
          .update({
            paid: update.paid,
            paid_at: update.paid ? new Date().toISOString() : null,
            paid_by: update.paidBy || null,
            updated_at: new Date().toISOString()
          })
          .eq('payout_id', payoutId)
          .eq('member_id', update.memberId);
          
        if (error) throw error;
      }
    }
    
    return true;
  } catch (error) {
    console.error("Error updating payment status:", error);
    return false;
  }
}

/**
 * Get payment history for a member
 */
export async function getMemberPaymentHistory(memberId: number): Promise<{
  warId: number;
  warDate: string;
  opponent: string;
  paymentAmount: number;
  paid: boolean;
  paidAt: string | null;
}[]> {
  try {
    // This query joins war_member_payouts with war_payouts and war_reports
    const { data, error } = await supabase
      .rpc('get_member_payment_history', { member_id_param: memberId })
      .order('war_date', { ascending: false });
      
    if (error) throw error;
    
    return data || [];
  } catch (error) {
    console.error(`Error getting payment history for member ${memberId}:`, error);
    return [];
  }
}