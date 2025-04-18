import { 
  Message, 
  EmbedBuilder, 
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { getWarReport, getWarContributions } from '../database/warReportRepository';
import { getAllConfigValues } from '../database/paymentConfigRepository';
import { activeReports, WarReportEntry } from './warReportTypes';
import { 
  fetchPaymentData, 
  verifyPaymentsWithDoubleCheck,
  generateWarReportEmbeds,
  createPaginationButtons,
  createActionButtons,
  createPaymentLinkRows
} from './warReportUtils';
import { 
  saveWarPayout, 
  saveWarMemberPayouts,
  getPayoutByWarId
} from '../database/payoutRepository';

/**
 * Handle the RW payout command
 */
export async function handleRWPayoutCommand(message: Message, args: string[]): Promise<void> {
  try {
    // Check if we have the required parameters
    if (args.length < 2) {
      await message.reply(
        "Please provide both war ID and total RW cash amount.\n" +
        "Usage: `!warreport payout <warId> <totalRwCash>`\n" +
        "Example: `!warreport payout 12345 10000000`"
      );
      return;
    }

    // Parse parameters
    const warId = parseInt(args[0]);
    const totalRwCash = parseFloat(args[1].replace(/,/g, ''));

    if (isNaN(warId)) {
      await message.reply("Invalid war ID. Please provide a valid number.");
      return;
    }

    if (isNaN(totalRwCash) || totalRwCash <= 0) {
      await message.reply("Invalid cash amount. Please provide a valid positive number.");
      return;
    }

    const progressMsg = await message.reply(`Processing payout for War ID ${warId} with total RW cash $${totalRwCash.toLocaleString()}...`);

    // Check if payout already exists
    const existingPayout = await getPayoutByWarId(warId);
    let shouldUseExisting = false;
    
    if (existingPayout.summary) {
      // Only proceed with using existing if the total RW cash is the same
      if (existingPayout.summary.total_rw_cash === totalRwCash) {
        shouldUseExisting = true;
        
        // Ask user if they want to use existing or regenerate
        const confirmMsg = await message.channel.send({
          content: `A payout for War ID ${warId} already exists with the same RW cash amount. Would you like to:`,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId('use_existing')
                .setLabel('Use Existing Payout')
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId('regenerate')
                .setLabel('Regenerate Payout')
                .setStyle(ButtonStyle.Secondary)
            )
          ]
        });
        
        // Wait for response
        try {
          const response = await confirmMsg.awaitMessageComponent({ time: 60000 });
          shouldUseExisting = response.customId === 'use_existing';
          await confirmMsg.delete();
        } catch (e) {
          // Timeout - default to using existing
          await confirmMsg.edit({
            content: `No response received. Defaulting to using existing payout data.`,
            components: []
          });
        }
      }
    }
    
    // If we're using existing data, skip recalculation
    if (shouldUseExisting && existingPayout.summary && existingPayout.members.length > 0) {
      await progressMsg.edit(`Using existing payout data for War ID ${warId}...`);
      
      // Transform existing data to the format expected by the report generation
      const entries: WarReportEntry[] = existingPayout.members.map(member => ({
        id: member.member_id.toString(),
        Member: member.member_name,
        War_hits: member.war_hits,
        Assists: member.assists,
        Under_Respect_Hits: member.under_respect_hits,
        Non_War_Hits: member.non_war_hits,
        Points: member.points.toString(),
        Total_Payout: member.payment_amount.toString(),
        Readable: new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        }).format(member.payment_amount).replace('$', '')
      }));
      
      // Fetch payment verification data
      await progressMsg.edit(`Loading payment verification data...`);
      const paymentNewsData = await fetchPaymentData(300);
      const { verifiedPayments } = verifyPaymentsWithDoubleCheck(entries, paymentNewsData);
      
      // Update database with verified payments
      const memberUpdates = Array.from(verifiedPayments.entries())
        .filter(([_, data]) => data.verified)
        .map(([memberId, _]) => ({
          memberId: parseInt(memberId),
          paid: true,
          paidBy: 'System (Auto-verified)'
        }));
      
      if (memberUpdates.length > 0) {
        await updatePaymentStatus(existingPayout.summary.id, memberUpdates);
        console.log(`Updated payment status for ${memberUpdates.length} members`);
      }
      
      // Continue with report generation using existing data...
      
    } else {
      // Get war report and member contributions
      const warReport = await getWarReport(warId);
      if (!warReport) {
        await progressMsg.edit(`No war report found for War ID: ${warId}`);
        return;
      }

      // Get member contributions
      const contributions = await getWarContributions(warId);
      if (contributions.length === 0) {
        await progressMsg.edit(`Found war report for ID: ${warId}, but no member contributions data is available.`);
        return;
      }

      await progressMsg.edit(`Found war report with ${contributions.length} members, calculating payouts...`);

      // Get configuration values
      const config = await getAllConfigValues();
      const minRespect = config.min_respect || 8;
      const hitMultiplier = config.hit_multiplier || 0;
      const rwHitMultiplier = config.rw_hit_multiplier || 0.8;
      const assistMultiplier = config.assist_multiplier || 0.2;
      const payoutPercentage = config.payout_percentage || 90;

      // Calculate payout amount
      const totalPayout = totalRwCash * (payoutPercentage / 100);
      const reservedAmount = totalRwCash - totalPayout;

      // Calculate total points
      let totalPoints = 0;
      contributions.forEach(member => {
        const memberPoints = 
          (member.war_hits * rwHitMultiplier) + 
          (member.under_respect_hits * hitMultiplier) + 
          (member.non_war_hits * hitMultiplier) + 
          (member.assists * assistMultiplier);
        
        totalPoints += memberPoints;
      });

      // Calculate payment per point
      const paymentPerPoint = totalPoints > 0 ? totalPayout / totalPoints : 0;

      // Generate entries in the format expected by the existing war report UI
      const entries: WarReportEntry[] = contributions
        .map(member => {
          // Calculate member points
          const memberPoints = 
            (member.war_hits * rwHitMultiplier) + 
            (member.under_respect_hits * hitMultiplier) + 
            (member.non_war_hits * hitMultiplier) + 
            (member.assists * assistMultiplier);
          
          // Calculate payment
          const payment = Math.round(memberPoints * paymentPerPoint);
          
          // Format as readable currency
          const readablePayment = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          }).format(payment).replace('$', '');
          
          // Create entry using the existing format
          return {
            id: member.member_id.toString(),
            Member: member.member_name,
            War_hits: member.war_hits,
            Assists: member.assists,
            Under_Respect_Hits: member.under_respect_hits || 0,
            Non_War_Hits: member.non_war_hits || 0,
            Points: memberPoints.toFixed(2),
            Total_Payout: payment.toString(),
            Readable: readablePayment
          };
        })
        .filter(entry => parseFloat(entry.Total_Payout) > 0)
        .sort((a, b) => parseInt(b.Total_Payout) - parseInt(a.Total_Payout));

      await progressMsg.edit(`Calculated payouts for ${entries.length} eligible members, checking payment verification...`);

      // Fetch payment verification data from faction news
      const paymentNewsData = await fetchPaymentData(300);
      const { verifiedPayments } = verifyPaymentsWithDoubleCheck(entries, paymentNewsData);

      // Set initial state
      const currentPage = 0;
      const pageSize = 10;
      const totalPages = Math.ceil(entries.length / pageSize);

      // Calculate activity totals
      let totalWarHits = 0;
      let totalNonWarHits = 0;
      let totalUnderRespectHits = 0;
      let totalAssists = 0;

      // Sum up all contributions
      contributions.forEach(member => {
        totalWarHits += member.war_hits || 0;
        totalNonWarHits += member.non_war_hits || 0;
        totalUnderRespectHits += member.under_respect_hits || 0;
        totalAssists += member.assists || 0;
      });

      // Generate embedded summary with activity totals
      const summaryEmbed = new EmbedBuilder()
        .setTitle(`💰 RW Payout for War ID: ${warId}`)
        .setColor("#00AA00")
        .setDescription(
          `**War:** ${warReport.our_score} - ${warReport.their_score} (${warReport.winner} won)\n` +
          `**Opponent:** ${warReport.opponent_name}\n\n` +
          `**Total RW Cash:** $${totalRwCash.toLocaleString()}\n` +
          `**Payout Amount (${payoutPercentage}%):** $${totalPayout.toLocaleString()}\n` +
          `**Reserved Amount (${100-payoutPercentage}%):** $${reservedAmount.toLocaleString()}\n` +
          `**Total Points:** ${totalPoints.toFixed(2)} ($${paymentPerPoint.toFixed(2)}/point)\n` +
          `**Members Eligible:** ${entries.length}\n\n` +
          `**Payment Multipliers:**\n` +
          `• War Hits (≥${minRespect}): ${rwHitMultiplier}\n` +
          `• Under Respect Hits: ${hitMultiplier}\n` +
          `• Non-War Hits: ${hitMultiplier}\n` +
          `• Assists: ${assistMultiplier}`
        );

      // Add activity statistics as a separate field
      summaryEmbed.addFields({
        name: '📊 Activity Summary',
        value: 
          `**War Hits:** ${totalWarHits.toLocaleString()}\n` +
          `**Under Respect Hits:** ${totalUnderRespectHits.toLocaleString()}\n` +
          `**Non-War Hits:** ${totalNonWarHits.toLocaleString()}\n` +
          `**Assists:** ${totalAssists.toLocaleString()}\n` +
          `**Total Actions:** ${(totalWarHits + totalNonWarHits + totalUnderRespectHits + totalAssists).toLocaleString()}`
      });

      // Add top 5 recipients
      const top5 = entries.slice(0, 5);
      if (top5.length > 0) {
        const topField = top5.map((entry, index) => 
          `**${index + 1}. ${entry.Member}:** $${entry.Readable} (${entry.War_hits} hits, ${entry.Assists} assists)`
        ).join('\n');
        
        summaryEmbed.addFields({
          name: '🏆 Top Recipients',
          value: topField
        });
      }

      await progressMsg.edit(`Summary prepared, generating interactive payment interface...`);

      // Generate embeds for paginated display - we'll need to import this function from warReportUtils
      const embeds = generateWarReportEmbeds(entries, verifiedPayments, pageSize);

      // Create buttons
      const components = [
        createPaginationButtons(currentPage, totalPages),
        createActionButtons(),
        ...createPaymentLinkRows(entries, verifiedPayments, currentPage, pageSize)
      ];

      // First send the summary embed
      await message.channel.send({
        embeds: [summaryEmbed],
      });

      // Then send the interactive payment interface
      const reportMessage = await message.channel.send({
        content: `**RW Payout Report** - Page ${currentPage + 1}/${totalPages}`,
        embeds: [embeds[currentPage]],
        components: components.filter(row => row.components.length > 0)
      });

      // Store state for this report to handle interactions
      activeReports.set(reportMessage.id, {
        entries,
        currentPage,
        pageSize,
        paymentData: verifiedPayments
      });

      // Export CSV with payment details
      const headers = [
        'Member ID',
        'Member Name',
        'War Hits',
        'Under Respect Hits',
        'Non War Hits',
        'Assists', 
        'Points',
        'Payment Amount',
        'Status'
      ].join(',');

      const rows = entries.map(entry => {
        const verification = verifiedPayments.get(entry.id);
        const isPaid = verification?.verified || false;
        const status = isPaid ? 'PAID' : 'PENDING';
        
        return [
          entry.id,
          `"${entry.Member}"`,
          entry.War_hits,
          entry.Under_Respect_Hits || '0',
          entry.Non_War_Hits || '0',
          entry.Assists,
          entry.Points || '0',
          entry.Total_Payout,
          status
        ].join(',');
      });

      const csv = [headers, ...rows].join('\n');
      const buffer = Buffer.from(csv, 'utf-8');
      const attachment = new AttachmentBuilder(buffer, {
        name: `rw-payout-${warId}.csv`
      });

      // Create faction bank commands
      const bankCommandsText = entries
        .filter(entry => {
          const verification = verifiedPayments.get(entry.id);
          return !verification?.verified;
        })
        .map(entry => `/factionbank give ${entry.id} ${entry.Total_Payout} RW payment for ${warReport.opponent_name} war`)
        .join('\n');

      const bankCommandsBuffer = Buffer.from(bankCommandsText, 'utf-8');
      // const bankCommandsAttachment = new AttachmentBuilder(bankCommandsBuffer, {
      //   name: `rw-payment-commands-${warId}.txt`
      // });

      // Send the files
      await message.channel.send({
        content: `Here are the payment files for War ID: ${warId}`,
        files: [attachment]
      });

      await progressMsg.edit(`✅ RW payout report for War ID ${warId} generated successfully!`);
    }
  } catch (error) {
    console.error("Error processing RW payout:", error);
    await message.reply("An error occurred while processing the RW payout. Please try again later.");
  }
}

/**
 * Handle payment verification button clicks
 */
export async function handlePaymentVerification(interaction, reportId, memberId, action) {
  try {
    // Get the active report data
    const reportData = activeReports.get(reportId);
    if (!reportData) {
      await interaction.reply({
        content: "This report has expired. Please generate a new report.",
        ephemeral: true
      });
      return;
    }
    
    // Find member entry
    const memberEntry = reportData.entries.find(e => e.id === memberId);
    if (!memberEntry) {
      await interaction.reply({
        content: "Member not found in this report.",
        ephemeral: true
      });
      return;
    }
    
    // Update payment status
    const isPaid = action === 'verify';
    
    // Update the local data
    if (isPaid) {
      reportData.paymentData.set(memberId, {
        verified: true,
        amount: parseInt(memberEntry.Total_Payout),
        timestamp: Date.now(),
        verifiedBy: interaction.user.tag
      });
    } else {
      reportData.paymentData.set(memberId, {
        verified: false,
        amount: parseInt(memberEntry.Total_Payout),
        timestamp: Date.now(),
        verifiedBy: interaction.user.tag
      });
    }
    
    // Update database status
    try {
      // First get the war_id from the entry title or description
      const warIdMatch = interaction.message.embeds[0].title.match(/War ID: (\d+)/);
      if (warIdMatch && warIdMatch[1]) {
        const warId = parseInt(warIdMatch[1]);
        
        // Get payout ID
        const { summary } = await getPayoutByWarId(warId);
        
        if (summary?.id) {
          await updatePaymentStatus(summary.id, [{
            memberId: parseInt(memberId),
            paid: isPaid,
            paidBy: interaction.user.tag
          }]);
        }
      }
    } catch (dbError) {
      console.error("Error updating payment status in database:", dbError);
      // Continue even if DB update fails
    }
    
    // Update the message
    const currentPage = reportData.currentPage;
    const embeds = generateWarReportEmbeds(
      reportData.entries,
      reportData.paymentData,
      reportData.pageSize
    );
    
    // Update pagination components
    const components = [
      createPaginationButtons(currentPage, Math.ceil(reportData.entries.length / reportData.pageSize)),
      createActionButtons(),
      ...createPaymentLinkRows(reportData.entries, reportData.paymentData, currentPage, reportData.pageSize)
    ];
    
    // Update the message
    await interaction.update({
      embeds: [embeds[currentPage]],
      components: components.filter(row => row.components.length > 0)
    });
    
  } catch (error) {
    console.error("Error handling payment verification:", error);
    await interaction.reply({
      content: "An error occurred while processing your request.",
      ephemeral: true
    });
  }
}


/**
 * Handle payout history command
 */
export async function handlePayoutHistoryCommand(message: Message, args: string[]): Promise<void> {
  try {
    // Check if we have a member ID
    if (args.length < 1) {
      await message.reply(
        "Please provide a member ID.\n" +
        "Usage: `!warreport history <memberId>`\n" +
        "Example: `!warreport history 2345678`"
      );
      return;
    }
    
    const memberId = parseInt(args[0]);
    
    if (isNaN(memberId)) {
      await message.reply("Invalid member ID. Please provide a valid number.");
      return;
    }
    
    const progressMsg = await message.reply(`Fetching payment history for member ID ${memberId}...`);
    
    // Get member name
    let memberName = args[0];
    try {
      const { data: memberData } = await supabase
        .from('faction_members')
        .select('name')
        .eq('id', memberId)
        .single();
        
      if (memberData) {
        memberName = memberData.name;
      }
    } catch (e) {
      console.log('Could not get member name, using ID as name');
    }
    
    // Get payment history
    const history = await getMemberPaymentHistory(memberId);
    
    if (history.length === 0) {
      await progressMsg.edit(`No payment history found for member ID ${memberId} (${memberName}).`);
      return;
    }
    
    // Calculate stats
    const totalPaid = history.filter(h => h.paid).reduce((sum, h) => sum + h.paymentAmount, 0);
    const totalPending = history.filter(h => !h.paid).reduce((sum, h) => sum + h.paymentAmount, 0);
    const totalAmount = history.reduce((sum, h) => sum + h.paymentAmount, 0);
    
    // Create embed
    const embed = new EmbedBuilder()
      .setTitle(`💰 Payment History for ${memberName}`)
      .setDescription(`**Member ID:** ${memberId}\n**Total Payments:** ${history.length}`)
      .setColor("#0099FF")
      .addFields(
        { name: 'Total Amount', value: `$${totalAmount.toLocaleString()}`, inline: true },
        { name: 'Paid', value: `$${totalPaid.toLocaleString()}`, inline: true },
        { name: 'Pending', value: `$${totalPending.toLocaleString()}`, inline: true }
      );
      
    // Add recent payment history (last 10)
    const recentHistory = history.slice(0, 10);
    const historyField = recentHistory.map(h => {
      const date = new Date(h.warDate).toLocaleDateString();
      return `**${date}** vs ${h.opponent}: $${h.paymentAmount.toLocaleString()} - ${h.paid ? '✅ Paid' : '⏳ Pending'}`;
    }).join('\n');
    
    embed.addFields({
      name: 'Recent Payments',
      value: historyField || 'No recent payments'
    });
    
    // Send embed
    await progressMsg.edit({
      content: null,
      embeds: [embed]
    });
    
  } catch (error) {
    console.error("Error fetching payment history:", error);
    await message.reply("An error occurred while fetching payment history.");
  }
}


/**
 * Handle verify all payments button
 */
export async function handleVerifyAllPayments(message: Message): Promise<void> {
  try {
    const progressMsg = await message.reply('Preparing to verify all pending payments...');
    
    // Ask for confirmation with war ID
    const confirmMsg = await message.channel.send({
      content: 'Please enter the War ID for which you want to verify all payments:',
    });
    
    // Wait for response
    const filter = (m: Message) => m.author.id === message.author.id;
    const collected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: 30000
    });
    
    if (collected.size === 0) {
      await progressMsg.edit('No response received. Operation cancelled.');
      return;
    }
    
    const response = collected.first()!;
    const warId = parseInt(response.content);
    
    if (isNaN(warId)) {
      await progressMsg.edit('Invalid war ID. Operation cancelled.');
      return;
    }
    
    // Delete the prompt and response
    await confirmMsg.delete().catch(() => {});
    await response.delete().catch(() => {});
    
    await progressMsg.edit(`Verifying all pending payments for War ID ${warId}...`);
    
    // Get payout data
    const payoutData = await getPayoutByWarId(warId);
    
    if (!payoutData.summary) {
      await progressMsg.edit(`No payout found for War ID ${warId}.`);
      return;
    }
    
    // Get all pending payments
    const pendingPayments = payoutData.members.filter(m => !m.paid);
    
    if (pendingPayments.length === 0) {
      await progressMsg.edit(`No pending payments found for War ID ${warId}.`);
      return;
    }
    
    // Update all pending payments
    const memberUpdates = pendingPayments.map(m => ({
      memberId: m.member_id,
      paid: true,
      paidBy: message.author.tag
    }));
    
    const updated = await updatePaymentStatus(payoutData.summary.id, memberUpdates);
    
    if (updated) {
      await progressMsg.edit(`✅ Successfully verified ${memberUpdates.length} pending payments for War ID ${warId}.`);
    } else {
      await progressMsg.edit(`❌ Failed to update payment status in the database.`);
    }
    
  } catch (error) {
    console.error("Error verifying all payments:", error);
    await message.reply("An error occurred while verifying payments.");
  }
}