import { Collection } from 'discord.js';

// Store payment verification data
export type PaymentVerification = {
    verified: boolean;
    verifiedBy: string | null;
    timestamp: number | null;
};

// Interface for double payment tracking
export interface PaymentVerificationWithCount extends PaymentVerification {
    count: number;
    allPayments: {
        admin: string;
        timestamp: number;
    }[];
}

// Report entry interface
export interface WarReportEntry {
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

// API news entry interface
export interface PaymentNews {
    id: string;
    text: string;
    timestamp: number;
}

// Active report state tracker
export interface ActiveReport { 
    entries: WarReportEntry[];
    currentPage: number;
    pageSize: number;
    paymentData: Map<string, PaymentVerification>;
}

// Declare global variable for export data
declare global {
    var duplicateExportData: Map<string, {
        data: any[];
        expires: number;
    }> | undefined;
}

// Export shared state
export const activeReports = new Map<string, ActiveReport>();

// API key
export const API_KEY = process.env.TORN_API_KEY;