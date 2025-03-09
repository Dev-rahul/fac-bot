import { 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder
} from 'discord.js';

import { 
    WarReportEntry, 
    PaymentVerification, 
    PaymentVerificationWithCount, 
    PaymentNews,
    API_KEY
} from './warReportTypes';

// Parse CSV function
export function parseWarReportCSV(csvContent: string): WarReportEntry[] {
    try {
        // Simple CSV parser (no need for external dependency)
        const lines = csvContent.split('\n');
        const headers = lines[0].split(',').map(header => 
            header.trim().replace(/^"|"$/g, '')
        );
        
        const records: WarReportEntry[] = [];
        
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            
            // Handle quoted values with commas inside them
            const values: string[] = [];
            let currentValue = '';
            let inQuotes = false;
            
            for (let char of lines[i]) {
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    values.push(currentValue.replace(/^"|"$/g, ''));
                    currentValue = '';
                } else {
                    currentValue += char;
                }
            }
            
            // Add the last value
            values.push(currentValue.replace(/^"|"$/g, ''));
            
            // Create record object
            const record: any = {};
            headers.forEach((header, index) => {
                if (index < values.length) {
                    record[header] = values[index];
                }
            });
            
            // Extract member ID and name
            const idMatch = record.Member.match(/\[(\d+)\]/);
            if (idMatch) {
                record.id = idMatch[1];
                record.name = record.Member.split('[')[0].trim();
            }
            
            // Skip entries with 0 payment needed
            const paymentAmount = parseInt(record.Total_Payout?.replace(/,/g, '') || '0');
            if (paymentAmount <= 0) continue;
            
            records.push(record as WarReportEntry);
        }
        
        return records;
    } catch (error) {
        console.error("Error parsing CSV:", error);
        return [];
    }
}

// Function to fetch payment data from API
export async function fetchPaymentData(fetchAmount: number = 300): Promise<PaymentNews[]> {
    try {
        const result: PaymentNews[] = [];
        let url = `https://api.torn.com/v2/faction/news?striptags=true&limit=100&sort=DESC&cat=depositFunds`;
        let hasMore = true;
        let lastTimestamp: number | null = null;
        
        while (hasMore && result.length < fetchAmount) {
            let apiUrl = url;
            if (lastTimestamp) {
                apiUrl = `${url}&to=${lastTimestamp}`;
            }
            
            const response = await fetch(apiUrl, {
                headers: {
                    'Authorization': `ApiKey ${API_KEY}`,
                    'accept': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.news && data.news.length > 0) {
                result.push(...data.news);
                // Update last timestamp for pagination
                const lastItem = data.news[data.news.length - 1];
                lastTimestamp = lastItem.timestamp;
            } else {
                hasMore = false;
            }
            
            // Check if there's a next link available
            if (!data._metadata?.links?.prev) {
                hasMore = false;
            }
        }
        
        return result;
    } catch (error) {
        console.error("Error fetching payment data:", error);
        return [];
    }
}

// Enhanced verification function to check for double payments
export function verifyPaymentsWithDoubleCheck(
    entries: WarReportEntry[],
    paymentData: PaymentNews[]
): {
    verifiedPayments: Map<string, PaymentVerification>;
    doublePayments: Map<string, PaymentVerificationWithCount>;
} {
    const verifiedPayments = new Map<string, PaymentVerification>();
    const doublePayments = new Map<string, PaymentVerificationWithCount>();
    
    for (const entry of entries) {
        if (!entry.id || !entry.Member) continue;

        // Parse the payment amount from the entry
        const paymentAmount = parseInt(entry.Total_Payout.replace(/,/g, ''));

        if (isNaN(paymentAmount) || paymentAmount <= 0) continue;
        
        // Track all matching payments for this entry
        const matchingPayments: {admin: string; timestamp: number}[] = [];

        // Search for matching payments in news data
        for (const payment of paymentData) {
            const text = payment.text || '';
            
            // Match increased balance format
            const increaseMatch = text.match(/^(.+?) increased (.+?)'s(?: Fatality)? money balance by \$([\d,]+) from/);
            
            if (increaseMatch) {
                const [, admin, recipient, amountStr] = increaseMatch;
                const amount = parseInt(amountStr.replace(/,/g, ''));
                
                const memberName = entry.Member.toLowerCase();
                const recipientName = recipient.toLowerCase();
                
                // Only match if the payment amount is EXACTLY the amount required and name matches
                if ((recipientName.includes(memberName) || memberName.includes(recipientName)) && 
                    amount === paymentAmount) {
                    
                    // Track this payment
                    matchingPayments.push({
                        admin,
                        timestamp: payment.timestamp
                    });
                }
            }
        }
        
        // Process matching payments
        if (matchingPayments.length > 0) {
            // Sort by timestamp (newest first)
            matchingPayments.sort((a, b) => b.timestamp - a.timestamp);
            
            // Set the verified payment data using the most recent payment
            const mostRecent = matchingPayments[0];
            verifiedPayments.set(entry.id, {
                verified: true,
                verifiedBy: mostRecent.admin,
                timestamp: mostRecent.timestamp
            });
            
            // Check for multiple payments
            if (matchingPayments.length > 1) {
                doublePayments.set(entry.id, {
                    verified: true,
                    verifiedBy: mostRecent.admin,
                    timestamp: mostRecent.timestamp,
                    count: matchingPayments.length,
                    allPayments: matchingPayments
                });
            }
        } else {
            // No payments found
            verifiedPayments.set(entry.id, {
                verified: false,
                verifiedBy: null,
                timestamp: null
            });
        }
    }
    return { verifiedPayments, doublePayments };
}

// Generate embeds for pagination
export function generateWarReportEmbeds(
    entries: WarReportEntry[], 
    paymentData: Map<string, PaymentVerification>,
    pageSize: number = 10
): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    
    // Sort by payout amount (descending)
    const sortedEntries = [...entries].sort((a, b) => 
        parseInt(b.Total_Payout.replace(/,/g, '')) - parseInt(a.Total_Payout.replace(/,/g, ''))
    );
    
    // Calculate total payout and stats
    const totalPayout = sortedEntries.reduce(
        (sum, entry) => sum + parseInt(entry.Total_Payout.replace(/,/g, '')), 0
    );
    
    const totalEntries = sortedEntries.length;
    const paidEntries = [...paymentData.values()].filter(p => p.verified).length;
    
    const formattedTotal = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 2
    }).format(totalPayout);
    
    // Split into pages - FIX: Correct the for loop condition
    for (let i = 0; i < sortedEntries.length; i += pageSize) {
        const pageEntries = sortedEntries.slice(i, i + pageSize);
        const pageNumber = Math.floor(i / pageSize) + 1;
        const totalPages = Math.ceil(sortedEntries.length / pageSize);
        
        const embed = new EmbedBuilder()
            .setTitle('💰 War Payout Report 💰')
            .setDescription(
                `Total payout: **$${formattedTotal}**\n` +
                `Progress: **${paidEntries}/${totalEntries}** members paid\n` +
                `Page ${pageNumber}/${totalPages}`
            )
            .setColor('#00BFFF')
            .setFooter({ text: `Use 'Verify Payments' to check for completed payments` });
        
        // Add fields for each entry
        pageEntries.forEach((entry) => {
            const paymentInfo = paymentData.get(entry.id || '');
            const isPaid = paymentInfo?.verified || false;
            
            let paidStatus = '';
            if (isPaid) {
                const date = paymentInfo?.timestamp ? 
                    new Date(paymentInfo.timestamp * 1000).toLocaleString() : '';
                paidStatus = `✅ **PAID** by ${paymentInfo?.verifiedBy} ${date ? `(${date})` : ''}`;
            } else {
                paidStatus = `⏳ Pending payment`;
            }
            
            // Create emoji prefix based on payment status
            const emojiPrefix = isPaid ? '✅' : '🔸';
            
            embed.addFields({
                name: `${emojiPrefix} ${entry.Member}`,
                value: `💵 **${entry.Readable}** | Hits: ${entry.War_hits} | Assists: ${entry.Assists}\n${paidStatus}`
            });
        });
        
        embeds.push(embed);
    }
    
    return embeds;
}

/**
 * Create pagination buttons
 */
export function createPaginationButtons(currentPage: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  
  // First page button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('first')
      .setLabel('⏮️ First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  // Previous page button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('prev')
      .setLabel('◀️ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0)
  );

  // Next page button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('next')
      .setLabel('Next ▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1)
  );

  // Last page button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('last')
      .setLabel('Last ⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1)
  );

  return row;
}

/**
 * Create action buttons
 */
export function createActionButtons(): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  // Verify payments button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('verify')
      .setLabel('✅ Verify Payments')
      .setStyle(ButtonStyle.Primary)
  );

  // Show unpaid button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('unpaid')
      .setLabel('💰 Show Unpaid')
      .setStyle(ButtonStyle.Secondary)
  );

  // Double check button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('doublecheck')
      .setLabel('🔍 Double Check')
      .setStyle(ButtonStyle.Secondary)
  );

  // Export status button
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('export')
      .setLabel('📊 Export Status')
      .setStyle(ButtonStyle.Secondary)
  );

  return row;
}

/**
 * Create payment link rows for the current page
 */
export function createPaymentLinkRows(
  entries: WarReportEntry[],
  verifiedPayments: Map<string, PaymentVerification>,
  currentPage: number,
  pageSize: number
): ActionRowBuilder<ButtonBuilder>[] {
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, entries.length);
  const pageEntries = entries.slice(start, end);

  // Create payment buttons for each entry on the current page
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  let currentRow = new ActionRowBuilder<ButtonBuilder>();
  let buttonCount = 0;

  for (const entry of pageEntries) {
    // Skip if already paid
    const verification = verifiedPayments.get(entry.id);
    if (verification?.verified) continue;

    // Create pay button with correct URL format
    const button = new ButtonBuilder()
      .setLabel(`Pay ${entry.Member}`)
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.torn.com/factions.php?step=your#/tab=controls&option=give-to-user&addMoneyTo=${entry.id}&money=${entry.Total_Payout}`);

    // Add button to current row
    currentRow.addComponents(button);
    buttonCount++;

    // Create new row if current is full (max 5 buttons per row)
    if (buttonCount === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder<ButtonBuilder>();
      buttonCount = 0;
    }
  }

  // Add any remaining buttons in the last row
  if (buttonCount > 0) {
    rows.push(currentRow);
  }

  return rows;
}