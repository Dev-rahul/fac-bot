import { 
    Message, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder, 
    TextChannel,
    ButtonInteraction,
    MessageFlags,
    AttachmentBuilder
} from "discord.js";
import * as fs from 'fs';
import * as path from 'path';

// API key
const API_KEY = process.env.TORN_API_KEY;

// Store payment verification data
type PaymentVerification = {
    verified: boolean;
    verifiedBy: string | null;
    timestamp: number | null;
}

// Add interface for double payment tracking
interface PaymentVerificationWithCount extends PaymentVerification {
    count: number;
    allPayments: {
        admin: string;
        timestamp: number;
    }[];
}

// Track pagination state for active reports
const activeReports = new Map<string, { 
    entries: WarReportEntry[], 
    currentPage: number,
    pageSize: number,
    paymentData: Map<string, PaymentVerification>
}>();

interface WarReportEntry {
    Member: string;
    Total_Payout: string;
    Readable: string;
    Link: string;
    Hits_total: string;
    War_hits: string;
    Assists: string;
    Hits_nonWar: string;
    id?: string;
    name?: string;
}

interface PaymentNews {
    id: string;
    text: string;
    timestamp: number;
}

// Filter out zero payments when parsing CSV
function parseWarReportCSV(csvContent: string): WarReportEntry[] {
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
async function fetchPaymentData(fetchAmount: number = 300): Promise<PaymentNews[]> {
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
function verifyPaymentsWithDoubleCheck(
    entries: WarReportEntry[],
    paymentData: PaymentNews[]
): {
    verifiedPayments: Map<string, PaymentVerification>;
    doublePayments: Map<string, PaymentVerificationWithCount>;
} {
    const verifiedPayments = new Map<string, PaymentVerification>();
    const doublePayments = new Map<string, PaymentVerificationWithCount>();
    const paymentCounts = new Map<string, number>();
    
    for (const entry of entries) {
        if (!entry.id || !entry.name) continue;
        
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
                
                const memberName = entry.name.toLowerCase();
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
function generateWarReportEmbeds(
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
    
    // Split into pages
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
        pageEntries.forEach((entry, index) => {
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

// Create buttons for pagination
function createPaginationButtons(currentPage: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('warreport_first')
                .setLabel('<<')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId('warreport_prev')
                .setLabel('<')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId('warreport_page')
                .setLabel(`Page ${currentPage + 1}/${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('warreport_next')
                .setLabel('>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1),
            new ButtonBuilder()
                .setCustomId('warreport_last')
                .setLabel('>>')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1)
        );
}

// Create rows of payment links
function createPaymentLinkRows(
    entries: WarReportEntry[],
    paymentData: Map<string, PaymentVerification>,
    currentPage: number,
    pageSize: number
): ActionRowBuilder<ButtonBuilder>[] {
    const sortedEntries = [...entries]
        .sort((a, b) => parseInt(b.Total_Payout.replace(/,/g, '')) - parseInt(a.Total_Payout.replace(/,/g, '')))
        .slice(currentPage * pageSize, (currentPage + 1) * pageSize);
    
    // Filter out paid entries
    const unpaidEntries = sortedEntries.filter(entry => 
        !paymentData.get(entry.id || '')?.verified
    );
    
    // Create rows of payment links - up to 10 links in 2 rows (5 per row)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    
    for (let i = 0; i < unpaidEntries.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        for (let j = 0; j < 5 && (i + j) < unpaidEntries.length; j++) {
            const entry = unpaidEntries[i + j];
            const name = entry.name || entry.Member.split('[')[0].trim();
            
            row.addComponents(
                new ButtonBuilder()
                    .setLabel(`Pay ${name.substring(0, 10)}`)
                    .setStyle(ButtonStyle.Link)
                    .setURL(entry.Link)
            );
        }
        
        if (row.components.length > 0) {
            rows.push(row);
        }
        
        // Max 2 rows of links
        if (rows.length >= 2) break;
    }
    
    return rows;
}

// Create updated action buttons with a double check button
function createActionButtons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('warreport_verify')
                .setLabel('🔄 Verify Payments')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('warreport_doublecheck')
                .setLabel('🔍 Check Duplicates')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('warreport_unpaid')
                .setLabel('📋 Show Unpaid')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('warreport_export')
                .setLabel('📊 Export Status')
                .setStyle(ButtonStyle.Secondary)
        );
}

// Command handler for war report
export async function handleWarReportCommand(message: Message, args: string[]): Promise<void> {
    // Check for verify command
    if (args.length > 0 && args[0].toLowerCase() === 'verify') {
        const memberId = args[1];
        
        if (!memberId) {
            await message.reply("Please provide a member ID to verify payments.");
            return;
        }
        
        try {
            await message.reply(`Checking payment history for member ID: ${memberId}...`);
            
            // Fetch payment data
            const paymentNewsData = await fetchPaymentData(300);
            
            // Filter for payments to this member
            const memberPayments = paymentNewsData.filter(payment => {
                const text = payment.text || '';
                const match = text.match(/increased (.+?)'s(?: Fatality)? money balance by/);
                return match && text.includes(`[${memberId}]`);
            });
            
            if (memberPayments.length === 0) {
                await message.reply(`No payment history found for member ID: ${memberId}`);
                return;
            }
            
            // Group payments by amount
            const paymentsByAmount = new Map<number, {
                count: number;
                payments: { admin: string; timestamp: number; text: string }[];
            }>();
            
            for (const payment of memberPayments) {
                const text = payment.text || '';
                const match = text.match(/increased .+?'s(?: Fatality)? money balance by \$([\d,]+) from/);
                
                if (match) {
                    const amount = parseInt(match[1].replace(/,/g, ''));
                    
                    if (!paymentsByAmount.has(amount)) {
                        paymentsByAmount.set(amount, {
                            count: 0,
                            payments: []
                        });
                    }
                    
                    const data = paymentsByAmount.get(amount)!;
                    data.count++;
                    data.payments.push({
                        admin: text.split(' ')[0],
                        timestamp: payment.timestamp,
                        text
                    });
                }
            }
            
            // Create embed to display payment history
            const embed = new EmbedBuilder()
                .setTitle(`Payment History for Member ID: ${memberId}`)
                .setColor(memberPayments.length > 0 ? '#00FF00' : '#FF0000')
                .setDescription(`Found ${memberPayments.length} payment records`);
            
            // Add fields for each payment amount
            for (const [amount, data] of paymentsByAmount.entries()) {
                const formattedAmount = new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0
                }).format(amount);
                
                // Format with warning for duplicate payments
                let fieldName = `Amount: ${formattedAmount}`;
                if (data.count > 1) {
                    fieldName = `⚠️ DUPLICATE: ${formattedAmount} (${data.count} times)`;
                }
                
                // Format each payment record
                const paymentDetails = data.payments.map(p => {
                    const date = new Date(p.timestamp * 1000).toLocaleString();
                    return `• Paid by **${p.admin}** on ${date}`;
                }).join('\n');
                
                embed.addFields({ name: fieldName, value: paymentDetails });
            }
            
            await message.reply({ embeds: [embed] });
            return;
        } catch (error) {
            console.error("Error verifying member payments:", error);
            await message.reply("Error checking payment history. Please try again later.");
            return;
        }
    }
    
    // Add to the handleWarReportCommand function after the verify specific user check

    // Check for verify all command
    if (args.length > 0 && (args[0].toLowerCase() === 'verifyall' || 
       (args[0].toLowerCase() === 'verify' && args[1]?.toLowerCase() === 'all'))) {
        
        try {
            const progressMsg = await message.reply("Fetching all recent payment history, this may take a moment...");
            
            // Fetch payment data - get more records for a comprehensive check
            const paymentNewsData = await fetchPaymentData(500);
            
            if (paymentNewsData.length === 0) {
                await progressMsg.edit("No payment history found in the faction news.");
                return;
            }
            
            // Group payments by recipient
            const paymentsByRecipient = new Map<string, {
                name: string;
                id: string;
                payments: {
                    amount: number;
                    admin: string;
                    timestamp: number;
                }[];
            }>();
            
            // Also track potential duplicates
            const potentialDuplicates: {
                name: string;
                id: string;
                amount: number;
                count: number;
                admins: string[];
            }[] = [];
            
            // Process all payment news
            for (const payment of paymentNewsData) {
                const text = payment.text || '';
                
                // Match increased balance format
                const increaseMatch = text.match(/^(.+?) increased (.+?)'s(?: Fatality)? money balance by \$([\d,]+) from/);
                
                if (!increaseMatch) continue;
                
                const [, admin, recipient, amountStr] = increaseMatch;
                const amount = parseInt(amountStr.replace(/,/g, ''));
                
                // Extract recipient ID if available
                const idMatch = recipient.match(/\[(\d+)\]/);
                const id = idMatch ? idMatch[1] : "unknown";
                const name = idMatch ? recipient.split('[')[0].trim() : recipient;
                
                // Track payment by recipient
                if (!paymentsByRecipient.has(id)) {
                    paymentsByRecipient.set(id, {
                        name,
                        id,
                        payments: []
                    });
                }
                
                paymentsByRecipient.get(id)?.payments.push({
                    amount,
                    admin,
                    timestamp: payment.timestamp
                });
            }
            
            // Check for duplicate payments (same amount to same recipient)
            for (const [id, data] of paymentsByRecipient.entries()) {
                // Group payments by amount
                const paymentsByAmount = new Map<number, {
                    count: number;
                    admins: string[];
                }>();
                
                for (const payment of data.payments) {
                    if (!paymentsByAmount.has(payment.amount)) {
                        paymentsByAmount.set(payment.amount, {
                            count: 0,
                            admins: []
                        });
                    }
                    
                    const info = paymentsByAmount.get(payment.amount)!;
                    info.count++;
                    if (!info.admins.includes(payment.admin)) {
                        info.admins.push(payment.admin);
                    }
                }
                
                // Check for duplicates
                for (const [amount, info] of paymentsByAmount.entries()) {
                    if (info.count > 1) {
                        potentialDuplicates.push({
                            name: data.name,
                            id,
                            amount,
                            count: info.count,
                            admins: info.admins
                        });
                    }
                }
            }
            
            // Calculate stats
            const totalPayments = paymentNewsData.length;
            const uniqueRecipients = paymentsByRecipient.size;
            const duplicateCount = potentialDuplicates.length;
            
            // Create summary embed
            const summaryEmbed = new EmbedBuilder()
                .setTitle('📊 Payment Verification Report')
                .setColor(duplicateCount > 0 ? '#FFA500' : '#00FF00')
                .setDescription(
                    `Analyzed ${totalPayments} recent payments to ${uniqueRecipients} unique members.\n` +
                    `Found ${duplicateCount} potential duplicate payments.`
                )
                .setFooter({ text: `Data from the last ${paymentNewsData.length} faction news entries` });
                
            // If we found duplicates, show them
            if (potentialDuplicates.length > 0) {
                // Sort by count (highest first)
                potentialDuplicates.sort((a, b) => b.count - a.count);
                
                // Add fields for up to 15 duplicates
                for (let i = 0; i < Math.min(15, potentialDuplicates.length); i++) {
                    const dupe = potentialDuplicates[i];
                    const formattedAmount = new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        maximumFractionDigits: 0
                    }).format(dupe.amount);
                    
                    summaryEmbed.addFields({
                        name: `⚠️ ${dupe.name} [${dupe.id}] - ${dupe.count}x ${formattedAmount}`,
                        value: `Paid by: ${dupe.admins.join(', ')}`
                    });
                }
            } else {
                summaryEmbed.addFields({
                    name: '✅ No duplicate payments found',
                    value: 'All payments appear to be unique.'
                });
            }
            
            // Add top recipients by payment count
            const topRecipients = [...paymentsByRecipient.values()]
                .sort((a, b) => b.payments.length - a.payments.length)
                .slice(0, 5);
                
            if (topRecipients.length > 0) {
                const topRecipientsField = topRecipients.map(r => 
                    `**${r.name}** [${r.id}]: ${r.payments.length} payment(s)`
                ).join('\n');
                
                summaryEmbed.addFields({
                    name: '👑 Top Recipients by Payment Count',
                    value: topRecipientsField
                });
            }
            
            // Show the payment verification report
            await progressMsg.edit({ 
                content: "Payment verification complete!",
                embeds: [summaryEmbed]
            });
            
            // If we found duplicates, offer to export them
            if (potentialDuplicates.length > 0) {
                const exportButton = new ButtonBuilder()
                    .setCustomId('warreport_exportdupes')
                    .setLabel('📊 Export Duplicates')
                    .setStyle(ButtonStyle.Primary);
                    
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(exportButton);
                
                const exportMsg = await message.channel.send({ 
                    content: `Found ${duplicateCount} potential duplicate payments. Would you like to export the full list?`,
                    components: [row]
                });
                
                // Store the duplicate data for later export
                // Using a new map to store duplicate export data temporarily (for 10 minutes)
                if (!global.duplicateExportData) {
                    global.duplicateExportData = new Map();
                }
                
                // Store the data with a 10-minute expiration
                const exportId = exportMsg.id;
                global.duplicateExportData.set(exportId, {
                    data: potentialDuplicates,
                    expires: Date.now() + 600000 // 10 minutes
                });
                
                // Clean up expired export data
                for (const [id, entry] of global.duplicateExportData.entries()) {
                    if (entry.expires < Date.now()) {
                        global.duplicateExportData.delete(id);
                    }
                }
            }
            
            return;
        } catch (error) {
            console.error("Error verifying all payments:", error);
            await message.reply("Error checking payment history. Please try again later.");
            return;
        }
    }
    
    // Original command logic for CSV upload
    if (message.attachments.size === 0) {
        await message.reply(
            "Please attach a CSV file with the war report data, or use `!warreport verify [memberID]` to check payment history for a specific member."
        );
        return;
    }
    
    // Rest of your existing code for handling CSV uploads
    const attachment = message.attachments.first();
    if (!attachment || !attachment.name?.toLowerCase().endsWith('.csv')) {
        await message.reply("The attached file must be a CSV file.");
        return;
    }
    
    try {
        const progressMsg = await message.reply("Processing war report...");
        
        // Download the CSV file
        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
        }
        
        const csvContent = await response.text();
        const entries = parseWarReportCSV(csvContent);
        
        if (entries.length === 0) {
            await progressMsg.edit("No valid data found in the CSV file or all entries have $0 payment.");
            return;
        }
        
        // Initial state
        const currentPage = 0;
        const pageSize = 10;
        const totalPages = Math.ceil(entries.length / pageSize);
        
        await progressMsg.edit("CSV parsed, fetching payment verification data...");
        
        // Fetch payment data from API
        const paymentNewsData = await fetchPaymentData(300);
        const { verifiedPayments, doublePayments } = verifyPaymentsWithDoubleCheck(entries, paymentNewsData);
        
        // Check for double payments
        if (doublePayments.size > 0) {
            const warningEmbed = new EmbedBuilder()
                .setTitle('⚠️ Double Payment Warning ⚠️')
                .setColor('#FF0000')
                .setDescription(`Found ${doublePayments.size} members who may have been paid multiple times!`);
            
            for (const [id, data] of doublePayments.entries()) {
                const entry = entries.find(e => e.id === id);
                if (!entry) continue;
                
                const paymentDetails = data.allPayments.map((p, idx) => {
                    const date = new Date(p.timestamp * 1000).toLocaleString();
                    return `${idx + 1}. By **${p.admin}** on ${date}`;
                }).join('\n');
                
                warningEmbed.addFields({
                    name: `${entry.Member} - ${data.count} payments of ${entry.Readable}`,
                    value: paymentDetails
                });
            }
            
            await message.channel.send({ embeds: [warningEmbed] });
        }
        
        await progressMsg.edit("Payment verification complete, generating report...");
        
        // Generate first page
        const embeds = generateWarReportEmbeds(entries, verifiedPayments, pageSize);
        
        // Create buttons
        const components = [
            createPaginationButtons(currentPage, totalPages),
            createActionButtons(),
            ...createPaymentLinkRows(entries, verifiedPayments, currentPage, pageSize)
        ];
        
        // Send the initial message
        const reportMessage = await message.channel.send({
            embeds: [embeds[currentPage]],
            components: components.filter(row => row.components.length > 0)
        });
        
        // Store state for this report
        activeReports.set(reportMessage.id, {
            entries,
            currentPage,
            pageSize,
            paymentData: verifiedPayments
        });
        
        await progressMsg.edit(
            doublePayments.size > 0 
                ? `War report loaded with ${doublePayments.size} potential double payments detected! Check warning message above.` 
                : "War report loaded successfully! Use the buttons to navigate."
        );
        
    } catch (error) {
        console.error("Error processing war report:", error);
        await message.reply("An error occurred while processing the war report.");
    }
}

// Handle button interactions for war reports
export async function handleWarReportButton(interaction: ButtonInteraction): Promise<void> {
    const messageId = interaction.message.id;
    const report = activeReports.get(messageId);
    
    if (!report) {
        await interaction.reply({
            content: "This report is no longer active. Please generate a new one.",
            flags: MessageFlags.Ephemeral
        });
        return;
    }
    
    const { entries, pageSize, paymentData } = report;
    let { currentPage } = report;
    const totalPages = Math.ceil(entries.length / pageSize);
    
    try {
        const customId = interaction.customId;
        
        // Handle buttons
        if (customId.startsWith('warreport_')) {
            switch (customId) {
                case 'warreport_first':
                    currentPage = 0;
                    break;
                    
                case 'warreport_prev':
                    currentPage = Math.max(0, currentPage - 1);
                    break;
                    
                case 'warreport_next':
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                    break;
                    
                case 'warreport_last':
                    currentPage = totalPages - 1;
                    break;
                    
                case 'warreport_verify':
                    // Verify payments from API
                    await interaction.deferReply();
                    
                    const freshPaymentNewsData = await fetchPaymentData(300);
                    const { verifiedPayments: updatedPaymentData } = verifyPaymentsWithDoubleCheck(entries, freshPaymentNewsData);
                    
                    // Update our stored data
                    for (const [id, verification] of updatedPaymentData.entries()) {
                        paymentData.set(id, verification);
                    }
                    
                    const paidCount = [...paymentData.values()].filter(p => p.verified).length;
                    const totalCount = entries.length;
                    
                    // Generate updated embeds
                    const updatedEmbeds = generateWarReportEmbeds(entries, paymentData, pageSize);
                    
                    // Create updated components
                    const updatedComponents = [
                        createPaginationButtons(currentPage, totalPages),
                        createActionButtons(),
                        ...createPaymentLinkRows(entries, paymentData, currentPage, pageSize)
                    ];
                    
                    // Update message
                    await interaction.message.edit({
                        embeds: [updatedEmbeds[currentPage]],
                        components: updatedComponents.filter(row => row.components.length > 0)
                    });
                    
                    await interaction.editReply({
                        content: `Payment verification complete! ${paidCount} out of ${totalCount} members have been paid.`
                    });
                    
                    return;
                    
                case 'warreport_export':
                    // Generate and send CSV of payment status
                    const timestamp = new Date().toISOString().replace(/:/g, '-').substring(0, 19);
                    const csvRows = ['Member,ID,Amount,Status,Paid By,Timestamp'];
                    
                    entries.forEach(entry => {
                        const verification = paymentData.get(entry.id || '');
                        const isPaid = verification?.verified || false;
                        const status = isPaid ? 'PAID' : 'PENDING';
                        const paidBy = isPaid && verification?.verifiedBy ? verification.verifiedBy : '';
                        const paidTime = isPaid && verification?.timestamp ? 
                            new Date(verification.timestamp * 1000).toISOString() : '';
                            
                        csvRows.push(`"${entry.Member}","${entry.id || ''}","${entry.Readable}","${status}","${paidBy}","${paidTime}"`);
                    });
                    
                    const csvContent = csvRows.join('\n');
                    const buffer = Buffer.from(csvContent, 'utf-8');
                    const attachment = new AttachmentBuilder(buffer, {name: `payment-status-${timestamp}.csv`});
                    
                    await interaction.reply({
                        content: "📊 Payment status exported as CSV:",
                        files: [attachment]
                    });
                    
                    return;
                    
                case 'warreport_unpaid':
                    // Show only unpaid members
                    const unpaidMembers = entries.filter(entry => 
                        !paymentData.get(entry.id || '')?.verified
                    );
                    
                    if (unpaidMembers.length === 0) {
                        await interaction.reply({
                            content: "🎉 All members have been marked as paid!",
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    
                    // Sort by payout amount
                    const sortedUnpaid = [...unpaidMembers].sort((a, b) => 
                        parseInt(b.Total_Payout.replace(/,/g, '')) - parseInt(a.Total_Payout.replace(/,/g, ''))
                    );
                    
                    // Calculate total unpaid
                    const totalUnpaid = sortedUnpaid.reduce(
                        (sum, entry) => sum + parseInt(entry.Total_Payout.replace(/,/g, '')), 0
                    );
                    
                    const formattedUnpaid = new Intl.NumberFormat('en-US', {
                        notation: 'compact',
                        compactDisplay: 'short',
                        maximumFractionDigits: 2
                    }).format(totalUnpaid);
                    
                    const unpaidEmbed = new EmbedBuilder()
                        .setTitle('📋 Unpaid Members')
                        .setColor('#FF7F50')
                        .setDescription(
                            `There are ${unpaidMembers.length} members still pending payment.\n` +
                            `Total remaining: **$${formattedUnpaid}**`
                        );
                    
                    // Add unpaid members (up to 25)
                    sortedUnpaid.slice(0, 25).forEach((entry, index) => {
                        unpaidEmbed.addFields({
                            name: `${index + 1}. ${entry.Member}`,
                            value: `💵 **${entry.Readable}** | Hits: ${entry.War_hits} | Assists: ${entry.Assists}`
                        });
                    });
                    
                    await interaction.reply({
                        embeds: [unpaidEmbed],
                        flags: MessageFlags.Ephemeral
                    });
                    
                    return;

                case 'warreport_doublecheck':
                    // Check for duplicate payments
                    await interaction.deferReply();
                    
                    const duplicateCheckNewsData = await fetchPaymentData(300);
                    const { doublePayments } = verifyPaymentsWithDoubleCheck(entries, duplicateCheckNewsData);
                    
                    if (doublePayments.size === 0) {
                        await interaction.editReply({
                            content: "✅ Good news! No duplicate payments detected."
                        });
                        return;
                    }
                    
                    // Create embed for duplicate payments
                    const doublePaymentEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Double Payment Warning ⚠️')
                        .setColor('#FF0000')
                        .setDescription(`Found ${doublePayments.size} members who may have been paid multiple times!`);
                    
                    let entriesAdded = 0;
                    
                    for (const [id, data] of doublePayments.entries()) {
                        if (entriesAdded >= 25) break; // Discord limit
                        
                        const entry = entries.find(e => e.id === id);
                        if (!entry) continue;
                        
                        const paymentDetails = data.allPayments.map((p, idx) => {
                            const date = new Date(p.timestamp * 1000).toLocaleString();
                            return `${idx + 1}. By **${p.admin}** on ${date}`;
                        }).join('\n');
                        
                        doublePaymentEmbed.addFields({
                            name: `${entry.Member} - ${data.count} payments of ${entry.Readable}`,
                            value: paymentDetails
                        });
                        
                        entriesAdded++;
                    }
                    
                    await interaction.editReply({
                        content: `⚠️ Found ${doublePayments.size} potential duplicate payments:`, 
                        embeds: [doublePaymentEmbed]
                    });
                    
                    return;

                case 'warreport_exportdupes':
                    if (!global.duplicateExportData) {
                        await interaction.reply({
                            content: "Export data no longer available. Please run the verify command again.",
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    
                    const exportData = global.duplicateExportData.get(interaction.message.id);
                    if (!exportData || exportData.expires < Date.now()) {
                        await interaction.reply({
                            content: "Export data has expired. Please run the verify command again.",
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                    
                    // Create CSV - using different variable names to avoid conflicts
                    const exportTimestamp = new Date().toISOString().replace(/:/g, '-').substring(0, 19);
                    const dupeCsvRows = ['Member,ID,Amount,Count,Paid By']; // Renamed to dupeCsvRows
                    
                    for (const dupe of exportData.data) {
                        dupeCsvRows.push( // Using the renamed variable
                            `"${dupe.name}","${dupe.id}","${dupe.amount}","${dupe.count}","${dupe.admins.join(', ')}"`
                        );
                    }
                    
                    const dupeCsvContent = dupeCsvRows.join('\n'); // Fixed variable name to use dupeCsvRows instead of csvRows
                    const dupeBuffer = Buffer.from(dupeCsvContent, 'utf-8'); // Renamed to dupeBuffer
                    const dupeAttachment = new AttachmentBuilder(dupeBuffer, { // Renamed to dupeAttachment
                        name: `duplicate-payments-${exportTimestamp}.csv`
                    });
                    
                    await interaction.reply({
                        content: "📊 Duplicate payments exported as CSV:",
                        files: [dupeAttachment] // Using the renamed variable
                    });
                    
                    return;
                    
                default:
                    // Update report state for navigation
                    activeReports.set(messageId, {
                        entries,
                        currentPage,
                        pageSize,
                        paymentData
                    });
                    
                    // Update embeds and buttons for new page
                    const embeds = generateWarReportEmbeds(entries, paymentData, pageSize);
                    
                    const components = [
                        createPaginationButtons(currentPage, totalPages),
                        createActionButtons(),
                        ...createPaymentLinkRows(entries, paymentData, currentPage, pageSize)
                    ];
                    
                    await interaction.update({
                        embeds: [embeds[currentPage]],
                        components: components.filter(row => row.components.length > 0)
                    });
                    
                    break;
            }
        }
        
    } catch (error) {
        console.error("Error handling war report button:", error);
        
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "An error occurred while processing your request.",
                flags: MessageFlags.Ephemeral
            });
        }
    }
}

// Declare global variable for export data
declare global {
    var duplicateExportData: Map<string, {
        data: any[];
        expires: number;
    }> | undefined;
}
