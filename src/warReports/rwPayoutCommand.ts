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
    const payoutPercentage = config.payout_percentage || 85;

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
  } catch (error) {
    console.error("Error processing RW payout:", error);
    await message.reply("An error occurred while processing the RW payout. Please try again later.");
  }
}