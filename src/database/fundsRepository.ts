import { supabase } from '../database/supabaseClient';

// Fund snapshot interface
export interface FundSnapshot {
  id?: number;
  timestamp?: string;
  total_money: number;
  members_money: number;
  faction_money: number;
}

// Transaction interface
export interface FundTransaction {
  id?: number;
  timestamp?: string;
  transaction_date: string;
  amount: number;
  balance_after?: number;
  type: 'expense' | 'income';
  category: string;
  description: string;
  recorded_by: string;
  message_link?: string;
}

/**
 * Save a new funds snapshot
 */
export async function saveFundsSnapshot(snapshot: FundSnapshot): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('faction_funds_snapshots')
      .insert(snapshot)
      .select('id')
      .single();
      
    if (error) throw error;
    return data.id;
  } catch (error) {
    console.error('Error saving funds snapshot:', error);
    return null;
  }
}

/**
 * Get the most recent funds snapshot
 */
export async function getLatestFundsSnapshot(): Promise<FundSnapshot | null> {
  try {
    const { data, error } = await supabase
      .from('faction_funds_snapshots')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();
      
    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No data found
      }
      throw error;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting latest funds snapshot:', error);
    return null;
  }
}

/**
 * Record a new fund transaction
 */
export async function recordFundTransaction(transaction: FundTransaction): Promise<number | null> {
  try {
    // Get the latest snapshot to calculate new balance
    const latestSnapshot = await getLatestFundsSnapshot();
    
    if (latestSnapshot) {
      // Calculate balance after transaction
      const currentBalance = latestSnapshot.faction_money;
      const balanceAfter = transaction.type === 'expense'
        ? currentBalance - transaction.amount
        : currentBalance + transaction.amount;
        
      transaction.balance_after = balanceAfter;
    }
    
    const { data, error } = await supabase
      .from('faction_funds_transactions')
      .insert(transaction)
      .select('id')
      .single();
      
    if (error) throw error;
    return data.id;
  } catch (error) {
    console.error('Error recording fund transaction:', error);
    return null;
  }
}

/**
 * Get all fund transactions within a date range
 */
export async function getFundTransactions(
  startDate?: string, 
  endDate?: string,
  category?: string,
  type?: 'expense' | 'income'
): Promise<FundTransaction[]> {
  try {
    let query = supabase
      .from('faction_funds_transactions')
      .select('*')
      .order('transaction_date', { ascending: false });
    
    if (startDate) {
      query = query.gte('transaction_date', startDate);
    }
    
    if (endDate) {
      query = query.lte('transaction_date', endDate);
    }
    
    if (category) {
      query = query.eq('category', category);
    }
    
    if (type) {
      query = query.eq('type', type);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting fund transactions:', error);
    return [];
  }
}

/**
 * Get fund snapshots history
 */
export async function getFundsHistory(limit: number = 10): Promise<FundSnapshot[]> {
  try {
    const { data, error } = await supabase
      .from('faction_funds_snapshots')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);
      
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting funds history:', error);
    return [];
  }
}