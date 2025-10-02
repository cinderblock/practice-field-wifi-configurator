import { CronJob } from 'cron';
import RadioManager from './radioManager.js';

/**
 * Configuration Scheduler for Radio Management
 *
 * Environment Variables (read in index.ts):
 * - RADIO_CLEAR_SCHEDULE: Cron expression for when to clear configurations (e.g., "0 6 * * *" for daily at 6am)
 * - RADIO_CLEAR_TIMEZONE: Timezone for the cron schedule (optional, defaults to system TZ)
 */

export function startConfigurationScheduler(radioManager: RadioManager, schedule: string, timezone?: string): void {
  try {
    const cronJob = new CronJob(
      schedule,
      async () => {
        console.log(`[${new Date().toISOString()}] Scheduled task triggered: Clearing all radio configurations`);
        try {
          await radioManager.clearAllConfigurations();
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error in scheduled configuration clear:`, error);
        }
      },
      null, // onComplete callback
      true, // start immediately
      timezone, // timezone (undefined means use system timezone)
    );

    const timezoneInfo = timezone || 'system default';
    console.log(
      `[${new Date().toISOString()}] Scheduled configuration clearing started with cron expression: "${schedule}" (timezone: ${timezoneInfo})`,
    );
    console.log(`Next execution: ${cronJob.nextDate()}`);
  } catch (error) {
    console.error('Failed to start scheduled configuration clearing:', error);
    console.error('Please check your RADIO_CLEAR_SCHEDULE cron expression format.');
  }
}
