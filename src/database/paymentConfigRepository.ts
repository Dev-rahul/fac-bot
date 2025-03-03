import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

// Create Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuration interface
export interface PaymentConfig {
  id?: number;
  key: string;
  value: number;
  description: string;
  created_at?: string;
  updated_at?: string;
}

// Default values (used as fallbacks if DB is unavailable)
const defaultConfigs: Record<string, number> = {
  min_respect: 8,
  hit_multiplier: 0,
  rw_hit_multiplier: 0.8, 
  assist_multiplier: 0.2
};

/**
 * Get a configuration value by key
 */
export async function getConfigValue(key: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('payment_config')
      .select('value')
      .eq('key', key)
      .single();

    if (error) {
      console.warn(`Error fetching config ${key}, using default value:`, error);
      return defaultConfigs[key] || 0;
    }

    return data.value;
  } catch (error) {
    console.error(`Error in getConfigValue(${key}):`, error);
    return defaultConfigs[key] || 0;
  }
}

/**
 * Get all payment configuration values
 */
export async function getAllConfigValues(): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from('payment_config')
      .select('key, value');

    if (error) {
      console.warn('Error fetching all configs, using defaults:', error);
      return { ...defaultConfigs };
    }

    const configs: Record<string, number> = {};
    data.forEach(item => {
      configs[item.key] = item.value;
    });

    return configs;
  } catch (error) {
    console.error('Error in getAllConfigValues():', error);
    return { ...defaultConfigs };
  }
}

/**
 * Set a configuration value
 */
export async function setConfigValue(key: string, value: number, description?: string): Promise<boolean> {
  try {
    // Check if the config exists
    const { data: existingConfig } = await supabase
      .from('payment_config')
      .select('id, description')
      .eq('key', key)
      .single();

    const now = new Date().toISOString();

    if (existingConfig) {
      // Update existing config
      const { error } = await supabase
        .from('payment_config')
        .update({ 
          value, 
          updated_at: now,
          description: description || existingConfig.description
        })
        .eq('id', existingConfig.id);

      if (error) {
        console.error(`Error updating config ${key}:`, error);
        return false;
      }
    } else {
      // Insert new config
      if (!description) {
        description = getDefaultDescription(key);
      }

      const { error } = await supabase
        .from('payment_config')
        .insert({ 
          key, 
          value, 
          description,
          created_at: now,
          updated_at: now
        });

      if (error) {
        console.error(`Error inserting config ${key}:`, error);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error(`Error in setConfigValue(${key}, ${value}):`, error);
    return false;
  }
}

/**
 * Get default description for a configuration key
 */
function getDefaultDescription(key: string): string {
  switch (key) {
    case 'min_respect':
      return 'Minimum respect needed for a hit to count as a ranked war hit';
    case 'hit_multiplier':
      return 'Multiplier for base hits (usually 0)';
    case 'rw_hit_multiplier':
      return 'Multiplier for ranked war hits';
    case 'assist_multiplier':
      return 'Multiplier for assists';
    default:
      return 'Custom configuration value';
  }
}

/**
 * Reset a configuration value to its default
 */
export async function resetConfigToDefault(key: string): Promise<boolean> {
  if (defaultConfigs[key] === undefined) {
    return false;
  }
  
  return await setConfigValue(key, defaultConfigs[key]);
}

/**
 * Reset all configuration values to defaults
 */
export async function resetAllConfigsToDefaults(): Promise<boolean> {
  try {
    for (const [key, value] of Object.entries(defaultConfigs)) {
      await setConfigValue(key, value);
    }
    return true;
  } catch (error) {
    console.error('Error resetting all configs:', error);
    return false;
  }
}

/**
 * Get all payment configurations with descriptions
 */
export async function getAllPaymentConfigs(): Promise<PaymentConfig[]> {
  try {
    const { data, error } = await supabase
      .from('payment_config')
      .select('*')
      .order('id');

    if (error) {
      console.warn('Error fetching payment configs:', error);
      return Object.entries(defaultConfigs).map(([key, value]) => ({
        key,
        value,
        description: getDefaultDescription(key)
      }));
    }

    return data;
  } catch (error) {
    console.error('Error in getAllPaymentConfigs():', error);
    return [];
  }
}