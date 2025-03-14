import { saveFundsSnapshot, getLatestFundsSnapshot, FundSnapshot } from '../database/fundsRepository';

interface MemberDonation {
  name: string;
  money_balance: number;
  points_balance: number;
}

interface DonationsResponse {
  donations: {
    [memberId: string]: MemberDonation;
  };
}

interface CurrencyResponse {
  faction_id: number;
  points: number;
  money: number;
}

/**
 * Fetch faction funds data and calculate actual faction funds
 */
export async function fetchFactionFunds(): Promise<FundSnapshot | null> {
  try {
    const API_KEY = process.env.TORN_API_KEY;
    
    // Fetch the total money (faction + all members)
    const currencyResponse = await fetch(
      'https://api.torn.com/v2/faction?selections=currency&striptags=true',
      {
        headers: {
          'Authorization': `ApiKey ${API_KEY}`,
          'accept': 'application/json'
        }
      }
    );
    
    if (!currencyResponse.ok) {
      throw new Error(`Currency API error: ${currencyResponse.status} ${currencyResponse.statusText}`);
    }
    
    const currencyData: CurrencyResponse = await currencyResponse.json();
    
    // Fetch the individual member donations (money balances)
    const donationsResponse = await fetch(
      'https://api.torn.com/v2/faction?selections=donations&striptags=true',
      {
        headers: {
          'Authorization': `ApiKey ${API_KEY}`,
          'accept': 'application/json'
        }
      }
    );
    
    if (!donationsResponse.ok) {
      throw new Error(`Donations API error: ${donationsResponse.status} ${donationsResponse.statusText}`);
    }
    
    const donationsData: DonationsResponse = await donationsResponse.json();
    
    // Calculate total member money
    let totalMembersMoney = 0;
    for (const [memberId, memberData] of Object.entries(donationsData.donations)) {
      totalMembersMoney += memberData.money_balance;
    }
    
    // Calculate faction funds (total money minus member balances)
    const factionMoney = currencyData.money - totalMembersMoney;
    
    // Create and save snapshot
    const snapshot: FundSnapshot = {
      total_money: currencyData.money,
      members_money: totalMembersMoney,
      faction_money: factionMoney
    };
    
    // Save the snapshot to the database
    await saveFundsSnapshot(snapshot);
    
    return snapshot;
  } catch (error) {
    console.error('Error fetching faction funds:', error);
    return null;
  }
}