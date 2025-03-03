import { 
    Message, 
    ButtonInteraction, 
    EmbedBuilder,
    MessageFlags,
    AttachmentBuilder 
} from "discord.js";

import { 
    activeReports, 
    WarReportEntry, 
    PaymentVerification
} from './warReportTypes';

import {
    parseWarReportCSV,
    fetchPaymentData,
    verifyPaymentsWithDoubleCheck,
    generateWarReportEmbeds,
    createPaginationButtons,
    createActionButtons,
    createPaymentLinkRows
} from './warReportUtils';

// Command handler for war report
export async function handleWarReportCommand(message: Message, args: string[]): Promise<void> {
    // Check for verify command
    if (args.length > 0 && args[0].toLowerCase() === 'verify') {
        const memberId = args[1];
        
        // Check for verify all command
        if (args.length > 1 && args[1]?.toLowerCase() === 'all') {
            await handleVerifyAllPayments(message);
            return;
        }
        
        if (!memberId) {
            await message.reply("Please provide a member ID to verify payments.");
            return;
        }
        
        await handleVerifySingleMember(message, memberId);
        return;
    }
    
    // Check for verify all command (alternative syntax)
    if (args.length > 0 && args[0].toLowerCase() === 'verifyall') {
        await handleVerifyAllPayments(message);
        return;
    }
    
    // Original command logic for CSV upload
    if (message.attachments.size === 0) {
        await message.reply(
            "Please attach a CSV file with the war report data, or use `!warreport verify [memberID]` to check payment history for a specific member."
        );
        return;
    }
    
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
                    const dupeCsvRows = ['Member,ID,Amount,Count,Paid By']; 
                    
                    for (const dupe of exportData.data) {
                        dupeCsvRows.push(
                            `"${dupe.name}","${dupe.id}","${dupe.amount}","${dupe.count}","${dupe.admins.join(', ')}"`
                        );
                    }
                    
                    const dupeCsvContent = dupeCsvRows.join('\n');
                    const dupeBuffer = Buffer.from(dupeCsvContent, 'utf-8');
                    const dupeAttachment = new AttachmentBuilder(dupeBuffer, {
                        name: `duplicate-payments-${exportTimestamp}.csv`
                    });
                    
                    await interaction.reply({
                        content: "📊 Duplicate payments exported as CSV:",
                        files: [dupeAttachment]
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

// Helper function for verifying a single member's payment history
async function handleVerifySingleMember(message: Message, memberId: string): Promise<void> {
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
    } catch (error) {
        console.error("Error verifying member payments:", error);
        await message.reply("Error checking payment history. Please try again later.");
    }
}

// Helper function for verifying all payments
async function handleVerifyAllPayments(message: Message): Promise<void> {
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
        
        // Store the duplicate data for export
        if (!global.duplicateExportData) {
            global.duplicateExportData = new Map();
        }
        
        // If we found duplicates, offer to export them
        if (potentialDuplicates.length > 0) {
            // Store the data with a 10-minute expiration
            const exportId = progressMsg.id;
            global.duplicateExportData.set(exportId, {
                data: potentialDuplicates,
                expires: Date.now() + 600000 // 10 minutes
            });
        }
    } catch (error) {
        console.error("Error verifying all payments:", error);
        await message.reply("Error checking payment history. Please try again later.");
    }
}