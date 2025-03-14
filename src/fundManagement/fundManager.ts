import { Message, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { fetchFactionFunds } from '../services/factionFundsService';
import { 
  getLatestFundsSnapshot, 
  getFundsHistory, 
  recordFundTransaction,
  getFundTransactions,
  FundSnapshot,
  FundTransaction
} from '../database/fundsRepository';

// Categories for fund transactions
const EXPENSE_CATEGORIES = [
  "Upgrades", "Properties", "Items", "Weapons", "Armor", 
  "Drugs", "Medical", "Temporary", "Special", "Other"
];

const INCOME_CATEGORIES = [
  "Donations", "Territory", "Raid", "War", "Competition", 
  "Item Sales", "Other"
];

/**
 * Handle the funds status command
 */
export async function handleFundsStatusCommand(message: Message): Promise<void> {
  try {
    const progressMsg = await message.reply('Fetching faction funds data...');
    
    // Get the current funds data from API
    const fundsData = await fetchFactionFunds();
    
    if (!fundsData) {
      await progressMsg.edit('Failed to fetch faction funds data. Please try again later.');
      return;
    }
    
    // Get the last 5 transactions
    const transactions = await getFundTransactions(undefined, undefined, undefined, undefined);
    const recentTransactions = transactions.slice(0, 5);
    
    // Create embed
    const embed = new EmbedBuilder()
      .setTitle('💰 Faction Funds Status')
      .setColor('#00AA00')
      .setDescription(`Last updated: <t:${Math.floor(Date.now() / 1000)}:R>`)
      .addFields(
        { 
          name: '📊 Current Balance', 
          value: `$${fundsData.faction_money.toLocaleString()}`, 
          inline: false 
        },
        { 
          name: '💵 Total Faction Money', 
          value: `$${fundsData.total_money.toLocaleString()}`, 
          inline: true 
        },
        { 
          name: '👤 Member Balances', 
          value: `$${fundsData.members_money.toLocaleString()}`, 
          inline: true 
        }
      );
    
    // Add recent transactions if available
    if (recentTransactions.length > 0) {
      const transactionsText = recentTransactions.map(t => {
        const type = t.type === 'expense' ? '🔻' : '🔼';
        const amount = t.amount.toLocaleString();
        return `${type} $${amount} - ${t.category} - ${t.description.substring(0, 30)}${t.description.length > 30 ? '...' : ''}`;
      }).join('\n');
      
      embed.addFields({ 
        name: '🔄 Recent Transactions', 
        value: transactionsText || 'No recent transactions'
      });
    }
    
    // Action buttons
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('funds_add')
          .setLabel('Add Transaction')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('funds_history')
          .setLabel('View History')
          .setStyle(ButtonStyle.Secondary)
      );
    
    await progressMsg.edit({ content: null, embeds: [embed], components: [row] });
    
  } catch (error) {
    console.error('Error handling funds status command:', error);
    await message.reply('An error occurred while getting faction funds status.');
  }
}

/**
 * Handle adding a new transaction
 */
export async function handleAddTransactionCommand(message: Message, args: string[]): Promise<void> {
  try {
    if (args.length < 4) {
      await message.reply(
        "Please provide all required information:\n" +
        "`!funds add <type> <amount> <category> <description>`\n" +
        "Example: `!funds add expense 1000000 Upgrades Purchased new faction upgrade`\n\n" +
        `Valid expense categories: ${EXPENSE_CATEGORIES.join(', ')}\n` +
        `Valid income categories: ${INCOME_CATEGORIES.join(', ')}`
      );
      return;
    }
    
    const type = args[0].toLowerCase();
    if (type !== 'expense' && type !== 'income') {
      await message.reply('Type must be either "expense" or "income".');
      return;
    }
    
    const amount = parseInt(args[1].replace(/,/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await message.reply('Amount must be a positive number.');
      return;
    }
    
    const category = args[2];
    const validCategories = type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
    if (!validCategories.includes(category)) {
      await message.reply(
        `Invalid category. Please use one of these: ${validCategories.join(', ')}`
      );
      return;
    }
    
    const description = args.slice(3).join(' ');
    if (description.length < 3) {
      await message.reply('Please provide a valid description (minimum 3 characters).');
      return;
    }
    
    // Create the transaction
    const transaction: FundTransaction = {
      transaction_date: new Date().toISOString(),
      amount,
      type: type as 'expense' | 'income',
      category,
      description,
      recorded_by: message.author.tag,
      message_link: message.url
    };
    
    const progressMsg = await message.reply('Recording transaction...');
    
    // Save to database
    const transactionId = await recordFundTransaction(transaction);
    
    if (!transactionId) {
      await progressMsg.edit('Failed to record transaction. Please try again.');
      return;
    }
    
    // Get updated balance
    const latestFunds = await getLatestFundsSnapshot();
    
    // Create confirmation embed
    const embed = new EmbedBuilder()
      .setTitle(`${type === 'expense' ? '🔻 Expense' : '🔼 Income'} Recorded`)
      .setColor(type === 'expense' ? '#FF0000' : '#00AA00')
      .addFields(
        { name: 'Amount', value: `$${amount.toLocaleString()}`, inline: true },
        { name: 'Category', value: category, inline: true },
        { name: 'Recorded By', value: message.author.tag, inline: true },
        { name: 'Description', value: description },
        { 
          name: 'Updated Balance', 
          value: latestFunds ? `$${latestFunds.faction_money.toLocaleString()}` : 'Unknown'
        }
      )
      .setFooter({ text: `Transaction ID: ${transactionId}` })
      .setTimestamp();
    
    await progressMsg.edit({ content: null, embeds: [embed] });
    
  } catch (error) {
    console.error('Error adding transaction:', error);
    await message.reply('An error occurred while recording the transaction.');
  }
}

/**
 * Handle viewing transaction history
 */
export async function handleTransactionHistoryCommand(message: Message, args: string[]): Promise<void> {
  try {
    // Parse optional filters
    let category: string | undefined;
    let type: 'expense' | 'income' | undefined;
    let startDate: string | undefined;
    let endDate: string | undefined;
    
    // Process arguments
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'category' && args[i+1]) {
        category = args[i+1];
        i++;
      } else if (args[i] === 'type' && args[i+1]) {
        if (args[i+1] === 'expense' || args[i+1] === 'income') {
          type = args[i+1];
        }
        i++;
      } else if (args[i] === 'from' && args[i+1]) {
        startDate = new Date(args[i+1]).toISOString();
        i++;
      } else if (args[i] === 'to' && args[i+1]) {
        endDate = new Date(args[i+1]).toISOString();
        i++;
      }
    }
    
    const progressMsg = await message.reply('Fetching transaction history...');
    
    // Get transactions with filters
    const transactions = await getFundTransactions(startDate, endDate, category, type);
    
    if (transactions.length === 0) {
      await progressMsg.edit('No transactions found with the specified filters.');
      return;
    }
    
    // Group transactions by date
    const groupedTransactions: { [date: string]: FundTransaction[] } = {};
    transactions.forEach(transaction => {
      const date = new Date(transaction.transaction_date).toLocaleDateString();
      if (!groupedTransactions[date]) {
        groupedTransactions[date] = [];
      }
      groupedTransactions[date].push(transaction);
    });
    
    // Calculate totals
    const totalExpenses = transactions
      .filter(t => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
      
    const totalIncome = transactions
      .filter(t => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
      
    // Create embed pages for each date
    const embeds = Object.entries(groupedTransactions).map(([date, dayTransactions]) => {
      const dayExpenses = dayTransactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0);
        
      const dayIncome = dayTransactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0);
      
      const transactionsText = dayTransactions.map(t => {
        const type = t.type === 'expense' ? '🔻' : '🔼';
        return `${type} $${t.amount.toLocaleString()} - ${t.category} - ${t.description.substring(0, 40)}${t.description.length > 40 ? '...' : ''}`;
      }).join('\n');
      
      return new EmbedBuilder()
        .setTitle(`Transaction History - ${date}`)
        .setColor('#0099FF')
        .setDescription(transactionsText)
        .addFields(
          { name: 'Day Expenses', value: `$${dayExpenses.toLocaleString()}`, inline: true },
          { name: 'Day Income', value: `$${dayIncome.toLocaleString()}`, inline: true },
          { name: 'Net Change', value: `$${(dayIncome - dayExpenses).toLocaleString()}`, inline: true }
        );
    });
    
    // Create summary embed
    const summaryEmbed = new EmbedBuilder()
      .setTitle('Transaction History Summary')
      .setColor('#0099FF')
      .addFields(
        { name: 'Total Expenses', value: `$${totalExpenses.toLocaleString()}`, inline: true },
        { name: 'Total Income', value: `$${totalIncome.toLocaleString()}`, inline: true },
        { name: 'Net Change', value: `$${(totalIncome - totalExpenses).toLocaleString()}`, inline: true },
        { name: 'Date Range', value: `${startDate ? new Date(startDate).toLocaleDateString() : 'All time'} to ${endDate ? new Date(endDate).toLocaleDateString() : 'Present'}` },
        { name: 'Filters', value: `Type: ${type || 'All'}\nCategory: ${category || 'All'}` }
      );
    
    // Place summary embed at the beginning
    embeds.unshift(summaryEmbed);
    
    // Send first embed and store the message for pagination handling
    if (embeds.length > 0) {
      await progressMsg.edit({ content: null, embeds: [embeds[0]] });
      // You would add pagination handling here if needed
    } else {
      await progressMsg.edit('No transactions found with the specified filters.');
    }
    
  } catch (error) {
    console.error('Error fetching transaction history:', error);
    await message.reply('An error occurred while fetching transaction history.');
  }
}

/**
 * Main funds command handler
 */
export async function handleFundsCommand(message: Message, args: string[]): Promise<void> {
  // Check admin permissions
  if (!message.member?.permissions.has('Administrator')) {
    await message.reply('You need administrator permissions to use this command.');
    return;
  }

  const subCommand = args[0]?.toLowerCase();
  
  switch (subCommand) {
    case 'status':
    case 'balance':
      await handleFundsStatusCommand(message);
      break;
    
    case 'add':
      await handleAddTransactionCommand(message, args.slice(1));
      break;
      
    case 'history':
      await handleTransactionHistoryCommand(message, args.slice(1));
      break;
      
    case 'log':
      await handleLogParseCommand(message, args.slice(1));
      break;
      
    default:
      await message.reply(
        "Available commands:\n" +
        "`!funds status` - View current faction fund balance\n" +
        "`!funds add <type> <amount> <category> <description>` - Record a transaction manually\n" +
        "`!funds log <message>` - Parse and record a transaction from a log message\n" +
        "`!funds history [type <type>] [category <category>] [from <date>] [to <date>]` - View transaction history"
      );
  }
}

/**
 * Handle funds button interactions
 */
export async function handleFundsButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  
  switch (customId) {
    case 'funds_add':
      await handleAddTransactionInteraction(interaction);
      break;
      
    case 'funds_history':
      await handleViewHistoryInteraction(interaction);
      break;
      
    default:
      await interaction.reply({ content: 'Unknown button interaction', ephemeral: true });
  }
}

/**
 * Show the transaction modal
 */
async function handleAddTransactionInteraction(interaction: ButtonInteraction): Promise<void> {
  try {
    // Create type selection buttons first
    const typeButtons = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('funds_add_expense')
          .setLabel('Record Expense')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('funds_add_income')
          .setLabel('Record Income')
          .setStyle(ButtonStyle.Success)
      );
      
    await interaction.reply({
      content: 'What type of transaction would you like to add?',
      components: [typeButtons],
      ephemeral: true
    });
  } catch (error) {
    console.error('Error handling add transaction button:', error);
    await interaction.reply({ 
      content: 'An error occurred while processing your request.',
      ephemeral: true
    });
  }
}

/**
 * Show the transaction history
 */
async function handleViewHistoryInteraction(interaction: ButtonInteraction): Promise<void> {
  try {
    await interaction.deferReply();
    
    // Get fund snapshot history
    const fundsHistory = await getFundsHistory(10);
    
    if (fundsHistory.length === 0) {
      await interaction.editReply('No funds history available.');
      return;
    }
    
    // Create embed
    const embed = new EmbedBuilder()
      .setTitle('💰 Faction Funds History')
      .setColor('#0099FF')
      .setDescription('Recent balance history:');
    
    // Create data table
    let tableData = '```\n';
    tableData += 'Date              | Faction Funds     | Change\n';
    tableData += '---------------------------------------------------\n';
    
    let previousFunds: number | null = null;
    
    fundsHistory.forEach((snapshot, index) => {
      const date = new Date(snapshot.timestamp!).toLocaleString();
      const funds = snapshot.faction_money;
      
      let change = '';
      if (previousFunds !== null) {
        const diff = funds - previousFunds;
        change = diff >= 0 ? `+$${diff.toLocaleString()}` : `-$${Math.abs(diff).toLocaleString()}`;
      }
      
      tableData += `${date.padEnd(18)} | $${funds.toLocaleString().padEnd(16)} | ${change}\n`;
      previousFunds = funds;
    });
    
    tableData += '```';
    
    embed.setDescription(tableData);
    
    // Add latest balance
    if (fundsHistory.length > 0) {
      embed.addFields({
        name: 'Current Balance',
        value: `$${fundsHistory[0].faction_money.toLocaleString()}`
      });
    }
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('Error handling view history button:', error);
    await interaction.editReply('An error occurred while fetching funds history.');
  }
}

/**
 * Parse a log message and extract transaction details
 * @param logMessage The log message to parse
 * @param recordedBy Who recorded this transaction
 * @returns Transaction details or null if parsing failed
 */
export function parseLogTransaction(logMessage: string, recordedBy: string): FundTransaction | null {
  try {
    const message = logMessage.trim();
    
    // Transaction type patterns
    const buyPatterns = [
      /bought (\d+)x (.*?) at \$([\d,]+) each for a total of \$([\d,]+)/i,
      /purchased (\d+)x (.*?) for \$([\d,]+)/i,
      /bought (.*?) for \$([\d,]+)/i
    ];
    
    const sellPatterns = [
      /sold (\d+)x (.*?) at \$([\d,]+) each for a total of \$([\d,]+)/i,
      /sold (.*?) for \$([\d,]+)/i
    ];
    
    const depositPatterns = [
      /deposited \$([\d,]+) into faction funds/i,
      /added \$([\d,]+) to faction/i,
      /donated \$([\d,]+) to faction/i
    ];
    
    const withdrawPatterns = [
      /withdrew \$([\d,]+) from faction funds/i,
      /took \$([\d,]+) from faction/i
    ];
    
    const upgradePatterns = [
      /upgraded (.*?) for \$([\d,]+)/i,
      /paid \$([\d,]+) for (.*?) upgrade/i
    ];
    
    // Extract timestamp if present
    let timestamp = new Date();
    const timestampMatch = message.match(/(\d{2}:\d{2}:\d{2} - \d{2}\/\d{2}\/\d{2})/);
    if (timestampMatch) {
      const [, timeStampStr] = timestampMatch;
      const [time, date] = timeStampStr.split(' - ');
      const [day, month, year] = date.split('/');
      const [hour, minute, second] = time.split(':');
      timestamp = new Date(`20${year}-${month}-${day}T${hour}:${minute}:${second}`);
    }
    
    // Check buy patterns (expense)
    for (const pattern of buyPatterns) {
      const match = message.match(pattern);
      if (match) {
        // Extract the last number in the match as the amount
        const amountStr = match[match.length - 1].replace(/,/g, '');
        const amount = parseInt(amountStr);
        
        if (isNaN(amount)) continue;
        
        const itemName = match[match.length - 2] || match[1];
        
        // Determine category based on item
        const category = categorizeItem(itemName);
        
        return {
          transaction_date: timestamp.toISOString(),
          amount,
          type: 'expense',
          category,
          description: `Purchased ${itemName}`,
          recorded_by: recordedBy
        };
      }
    }
    
    // Check sell patterns (income)
    for (const pattern of sellPatterns) {
      const match = message.match(pattern);
      if (match) {
        // Extract the last number in the match as the amount
        const amountStr = match[match.length - 1].replace(/,/g, '');
        const amount = parseInt(amountStr);
        
        if (isNaN(amount)) continue;
        
        const itemName = match[match.length - 2] || match[1];
        
        return {
          transaction_date: timestamp.toISOString(),
          amount,
          type: 'income',
          category: 'Item Sales',
          description: `Sold ${itemName}`,
          recorded_by: recordedBy
        };
      }
    }
    
    // Check deposit patterns (income)
    for (const pattern of depositPatterns) {
      const match = message.match(pattern);
      if (match) {
        const amountStr = match[1].replace(/,/g, '');
        const amount = parseInt(amountStr);
        
        if (isNaN(amount)) continue;
        
        return {
          transaction_date: timestamp.toISOString(),
          amount,
          type: 'income',
          category: 'Donations',
          description: `Funds deposit`,
          recorded_by: recordedBy
        };
      }
    }
    
    // Check withdraw patterns (expense)
    for (const pattern of withdrawPatterns) {
      const match = message.match(pattern);
      if (match) {
        const amountStr = match[1].replace(/,/g, '');
        const amount = parseInt(amountStr);
        
        if (isNaN(amount)) continue;
        
        return {
          transaction_date: timestamp.toISOString(),
          amount,
          type: 'expense',
          category: 'Other',
          description: `Funds withdrawal`,
          recorded_by: recordedBy
        };
      }
    }
    
    // Check upgrade patterns (expense)
    for (const pattern of upgradePatterns) {
      const match = message.match(pattern);
      if (match) {
        const amountStr = match[match.length - 1].replace(/,/g, '');
        const amount = parseInt(amountStr);
        
        if (isNaN(amount)) continue;
        
        const upgradeName = match[1];
        
        return {
          transaction_date: timestamp.toISOString(),
          amount,
          type: 'expense',
          category: 'Upgrades',
          description: `Upgraded ${upgradeName}`,
          recorded_by: recordedBy
        };
      }
    }
    
    // No pattern matched
    return null;
  } catch (error) {
    console.error('Error parsing log transaction:', error);
    return null;
  }
}

/**
 * Determine category based on item name
 */
function categorizeItem(itemName: string): string {
  itemName = itemName.toLowerCase();
  
  // Define category keywords
  const categoryMap: Record<string, string[]> = {
    "Weapons": ['gun', 'rifle', 'pistol', 'shotgun', 'machine', 'weapon'],
    "Armor": ['body', 'helmet', 'armor', 'vest', 'tactical', 'kevlar'],
    "Drugs": ['xanax', 'lsd', 'speed', 'pcp', 'vicodin', 'drug', 'cannabis', 'cocaine', 'ketamine', 'opium', 'shrooms', 'ecstasy'],
    "Medical": ['medical', 'first aid', 'blood bag', 'morphine', 'melatonin', 'painkiller', 'energy drink', 'first-aid'],
    "Temporary": ['bottle', 'drink', 'supply', 'boost', 'alcohol', 'beer', 'whiskey', 'energy drink'],
    "Properties": ['property', 'mansion', 'house', 'apartment', 'palace'],
    "Special": ['special', 'flower', 'plushie', 'book', 'mp3 player', 'dvd'],
    "Items": ['item', 'key', 'ticket', 'box', 'candy', 'chocolate', 'sweet', 'food']
  };
  
  // Check each category
  for (const [category, keywords] of Object.entries(categoryMap)) {
    if (keywords.some(keyword => itemName.includes(keyword))) {
      return category;
    }
  }
  
  // Default category
  return "Other";
}

/**
 * Handle log parsing command
 * This allows users to paste a log message and have it automatically parsed and recorded
 */
export async function handleLogParseCommand(message: Message, args: string[]): Promise<void> {
  try {
    if (args.length < 1) {
      await message.reply(
        "Please provide a log message to parse.\n" +
        "Example: `!funds log You bought 100x Melatonin at $300,000 each for a total of $30,000,000 from the Pharmacy`"
      );
      return;
    }
    
    // Get the full log message
    const logMessage = args.join(' ');
    
    // Parse the log
    const transaction = parseLogTransaction(logMessage, message.author.tag);
    
    if (!transaction) {
      await message.reply("Could not parse the log message. Please check the format and try again.");
      return;
    }
    
    const progressMsg = await message.reply(`Parsed transaction: ${transaction.type} of $${transaction.amount.toLocaleString()} for ${transaction.category}. Recording...`);
    
    // Record the transaction
    const transactionId = await recordFundTransaction(transaction);
    
    if (!transactionId) {
      await progressMsg.edit('Failed to record transaction. Please try again.');
      return;
    }
    
    // Get updated balance
    const latestFunds = await getLatestFundsSnapshot();
    
    // Create confirmation embed
    const embed = new EmbedBuilder()
      .setTitle(`${transaction.type === 'expense' ? '🔻 Expense' : '🔼 Income'} Recorded from Log`)
      .setColor(transaction.type === 'expense' ? '#FF0000' : '#00AA00')
      .addFields(
        { name: 'Amount', value: `$${transaction.amount.toLocaleString()}`, inline: true },
        { name: 'Category', value: transaction.category, inline: true },
        { name: 'Recorded By', value: transaction.recorded_by, inline: true },
        { name: 'Description', value: transaction.description },
        { 
          name: 'Updated Balance', 
          value: latestFunds ? `$${latestFunds.faction_money.toLocaleString()}` : 'Unknown'
        }
      )
      .setFooter({ text: `Transaction ID: ${transactionId}` })
      .setTimestamp();
    
    await progressMsg.edit({ content: null, embeds: [embed] });
    
  } catch (error) {
    console.error('Error handling log parse command:', error);
    await message.reply('An error occurred while parsing the log.');
  }
}