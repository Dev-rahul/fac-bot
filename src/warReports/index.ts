import { Message } from 'discord.js';
import { handleWarReportCommand as originalHandler, handleWarReportButton } from './warReportCommands';
import { handleGenerateWarReport, handleHistoricalReports } from './warReportGenerator';
import { handleConfigCommand } from './configCommand';
import { handleRWPayoutCommand } from './rwPayoutCommand';

// Enhanced handler that includes all functionality
export async function handleWarReportCommand(message: Message, args: string[]): Promise<void> {
  // Check for generate command
  if (args.length > 0 && (args[0].toLowerCase() === 'generate' || args[0].toLowerCase() === 'gen')) {
    await handleGenerateWarReport(message, args.slice(1));
    return;
  }
  
  // Check for history command
  if (args.length > 0 && (args[0].toLowerCase() === 'history' || args[0].toLowerCase() === 'hist')) {
    await handleHistoricalReports(message, args.slice(1));
    return;
  }
  
  // Check for config command
  if (args.length > 0 && args[0].toLowerCase() === 'config') {
    await handleConfigCommand(message, args.slice(1));
    return;
  }
  
  // Check for payout command
  if (args.length > 0 && (args[0].toLowerCase() === 'payout' || args[0].toLowerCase() === 'pay')) {
    await handleRWPayoutCommand(message, args.slice(1));
    return;
  }
  
  // If no specialized command matched, use the original handler
  await originalHandler(message, args);
}

export { handleWarReportButton };