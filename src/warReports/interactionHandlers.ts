import { ButtonInteraction, MessageFlags, AttachmentBuilder } from 'discord.js';
import { activeReports } from './warReportTypes';
import { 
  generateWarReportEmbeds, 
  createPaginationButtons, 
  createActionButtons, 
  createPaymentLinkRows,
  fetchPaymentData,
  verifyPaymentsWithDoubleCheck
} from './warReportUtils';

/**
 * Handle pagination button clicks (first, previous, next, last)
 */
export async function handlePaginationButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const messageId = interaction.message.id;
    const reportData = activeReports.get(messageId);
    
    if (!reportData) {
      await interaction.reply({ 
        content: "Sorry, this report is no longer active.", 
        flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
      });
      return;
    }
    
    let { entries, currentPage, pageSize, paymentData } = reportData;
    const totalPages = Math.ceil(entries.length / pageSize);
    
    // Update page based on button clicked
    switch (interaction.customId) {
      case 'first':
        currentPage = 0;
        break;
      case 'prev':
        currentPage = Math.max(0, currentPage - 1);
        break;
      case 'next':
        currentPage = Math.min(totalPages - 1, currentPage + 1);
        break;
      case 'last':
        currentPage = totalPages - 1;
        break;
    }
    
    // Generate new embeds with updated page
    const embeds = generateWarReportEmbeds(entries, paymentData, pageSize);
    
    // Create buttons for the updated page
    const paginationRow = createPaginationButtons(currentPage, totalPages);
    const actionRow = createActionButtons();
    const paymentRows = createPaymentLinkRows(entries, paymentData, currentPage, pageSize);
    
    const components = [paginationRow, actionRow, ...paymentRows]
      .filter(row => row.components.length > 0);
    
    // Update the message
    await interaction.update({
      content: `**RW Payout Report** - Page ${currentPage + 1}/${totalPages}`,
      embeds: [embeds[currentPage]],
      components: components
    });
    
    // Update the active report data
    activeReports.set(messageId, {
      entries,
      currentPage,
      pageSize,
      paymentData
    });
  } catch (error) {
    console.error('Error handling pagination:', error);
    await interaction.reply({ 
      content: 'An error occurred while changing pages.', 
      flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
    });
  }
}

/**
 * Handle verify payments button click
 */
export async function handleVerifyButton(interaction: ButtonInteraction): Promise<void> {
  console.log("handleVerifyButton clicked")
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Updated from ephemeral: true
    
    const messageId = interaction.message.id;
    const reportData = activeReports.get(messageId);
    
    if (!reportData) {
      await interaction.editReply("Sorry, this report is no longer active.");
      return;
    }
    
    await interaction.editReply("Fetching payment data from faction news...");
    
    // Fetch fresh payment data
    const paymentNewsData = await fetchPaymentData(300);
    const { verifiedPayments, doublePayments } = verifyPaymentsWithDoubleCheck(
      reportData.entries, 
      paymentNewsData
    );
    
    // Update report data
    reportData.paymentData = verifiedPayments;
    activeReports.set(messageId, reportData);
    
    // Generate updated embeds
    const embeds = generateWarReportEmbeds(
      reportData.entries, 
      verifiedPayments, 
      reportData.pageSize
    );
    
    const totalPages = Math.ceil(reportData.entries.length / reportData.pageSize);
    
    // Create updated buttons
    const paginationRow = createPaginationButtons(reportData.currentPage, totalPages);
    const actionRow = createActionButtons();
    const paymentRows = createPaymentLinkRows(
      reportData.entries, 
      verifiedPayments, 
      reportData.currentPage, 
      reportData.pageSize
    );
    
    const components = [paginationRow, actionRow, ...paymentRows]
      .filter(row => row.components.length > 0);
    
    // Update the message
    await interaction.message.edit({
      content: `**RW Payout Report** - Page ${reportData.currentPage + 1}/${totalPages}`,
      embeds: [embeds[reportData.currentPage]],
      components: components
    });
    
    const paidCount = Array.from(verifiedPayments.values()).filter(p => p.verified).length;
    const totalCount = reportData.entries.length;
    
    // Show double payments if any were found
    if (doublePayments.size > 0) {
      let doublePaymentText = "⚠️ **Possible Double Payments Detected:**\n\n";
      
      Array.from(doublePayments.entries()).forEach(([memberId, payment]) => {
        const member = reportData.entries.find(e => e.id === memberId);
        if (member) {
          doublePaymentText += `**${member.Member}** - Paid ${payment.count} times\n`;
        }
      });
      
      await interaction.followUp({
        content: doublePaymentText,
        flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
      });
    }
    
    await interaction.editReply(`✅ Payment verification complete! Found ${paidCount} paid out of ${totalCount} members.`);
  } catch (error) {
    console.error('Error verifying payments:', error);
    await interaction.editReply('An error occurred while verifying payments.');
  }
}

/**
 * Handle show unpaid button click
 */
export async function handleUnpaidButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const messageId = interaction.message.id;
    const reportData = activeReports.get(messageId);
    
    if (!reportData) {
      await interaction.reply({ 
        content: "Sorry, this report is no longer active.", 
        flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
      });
      return;
    }
    
    // Filter unpaid entries
    const unpaidEntries = reportData.entries.filter(entry => {
      const verification = reportData.paymentData.get(entry.id);
      return !verification?.verified;
    });
    
    if (unpaidEntries.length === 0) {
      await interaction.reply({ 
        content: "🎉 All members have been paid!", 
        flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
      });
      return;
    }
    
    // Create a text list of unpaid members
    const unpaidList = unpaidEntries
      .map(entry => `- ${entry.Member}: $${entry.Readable}`)
      .join('\n');
    
    const unpaidTotal = unpaidEntries.reduce(
      (sum, entry) => sum + parseInt(entry.Total_Payout.replace(/,/g, '')), 0
    );
    
    await interaction.reply({
      content: `**${unpaidEntries.length} Unpaid Members (Total: $${unpaidTotal.toLocaleString()}):**\n${unpaidList}`,
      flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
    });
  } catch (error) {
    console.error('Error showing unpaid members:', error);
    await interaction.reply({ 
      content: 'An error occurred while showing unpaid members.', 
      flags: MessageFlags.Ephemeral  // Updated from ephemeral: true
    });
  }
}

/**
 * Handle double check button click
 */
export async function handleDoubleCheckButton(interaction: ButtonInteraction): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Updated from ephemeral: true
    
    const messageId = interaction.message.id;
    const reportData = activeReports.get(messageId);
    
    if (!reportData) {
      await interaction.editReply("Sorry, this report is no longer active.");
      return;
    }
    
    await interaction.editReply("Double checking payment data against faction news...");
    
    // Fetch fresh payment data
    const paymentNewsData = await fetchPaymentData(300);
    const { verifiedPayments, doublePayments } = verifyPaymentsWithDoubleCheck(
      reportData.entries, 
      paymentNewsData
    );
    
    if (doublePayments.size === 0) {
      await interaction.editReply("✅ No double payments detected.");
      return;
    }
    
    let doublePaymentText = "⚠️ **Possible Double Payments Detected:**\n\n";
    
    Array.from(doublePayments.entries()).forEach(([memberId, payment]) => {
      const member = reportData.entries.find(e => e.id === memberId);
      if (member) {
        const payments = payment.allPayments || [];
        
        doublePaymentText += `**${member.Member}** - $${member.Readable}\n`;
        doublePaymentText += `Paid ${payment.count} times:\n`;
        
        payments.forEach((p, i) => {
          const date = new Date(p.timestamp * 1000).toLocaleString();
          doublePaymentText += `${i+1}. By ${p.admin} on ${date}\n`;
        });
        
        doublePaymentText += "\n";
      }
    });
    
    await interaction.editReply(doublePaymentText);
  } catch (error) {
    console.error('Error checking for double payments:', error);
    await interaction.editReply('An error occurred while checking for double payments.');
  }
}

/**
 * Handle export status button click
 */
export async function handleExportButton(interaction: ButtonInteraction): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // Updated from ephemeral: true
    
    const messageId = interaction.message.id;
    const reportData = activeReports.get(messageId);
    
    if (!reportData) {
      await interaction.editReply("Sorry, this report is no longer active.");
      return;
    }
    
    const { entries, paymentData } = reportData;
    
    // Generate CSV content
    const headers = [
      'Member ID',
      'Member Name',
      'War Hits',
      'Assists',
      'Under Respect Hits',
      'Non-War Hits',
      'Payment Amount',
      'Status',
      'Paid By',
      'Payment Time'
    ].join(',');
    
    const rows = entries.map(entry => {
      const verification = paymentData.get(entry.id);
      const isPaid = verification?.verified || false;
      const status = isPaid ? 'PAID' : 'PENDING';
      const paidBy = verification?.verifiedBy || '';
      const paymentTime = verification?.timestamp ? 
        new Date(verification.timestamp * 1000).toLocaleString() : '';
      
      return [
        entry.id,
        `"${entry.Member}"`,
        entry.War_hits,
        entry.Assists,
        entry.Under_Respect_Hits || '0',
        entry.Non_War_Hits || '0',
        entry.Total_Payout,
        status,
        paidBy,
        paymentTime
      ].join(',');
    });
    
    const csv = [headers, ...rows].join('\n');
    const buffer = Buffer.from(csv, 'utf-8');
    
    // Create file attachment
    const attachment = new AttachmentBuilder(buffer, {
      name: `payment-status-${new Date().toISOString().slice(0,10)}.csv`
    });
    
    await interaction.editReply({
      content: `Payment status exported as CSV (${entries.length} members)`,
      files: [attachment]
    });
  } catch (error) {
    console.error('Error exporting payment status:', error);
    await interaction.editReply('An error occurred while exporting payment status.');
  }
}