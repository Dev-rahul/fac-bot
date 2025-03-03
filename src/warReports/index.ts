import { handleWarReportCommand as originalHandler, handleWarReportButton } from './warReportCommands';
import { 
  handleGenerateWarReport, 
  handleHistoricalReports,
  handleDisplayHistoricReports
} from './warReportGenerator';
import { Message } from 'discord.js';

// Create an enhanced handler that includes the generator functionality
async function handleWarReportCommand(message: Message, args: string[]): Promise<void> {
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
    
    // Add display command
    if (args.length > 0 && (args[0].toLowerCase() === 'display' || args[0].toLowerCase() === 'show')) {
        await handleDisplayHistoricReports(message, args.slice(1));
        return;
    }
    
    // Otherwise use the original handler
    await originalHandler(message, args);
}

// Export the enhanced handlers
export { 
    handleWarReportCommand, 
    handleWarReportButton 
};