import { getStore } from '@netlify/blobs';
import { createStorage } from './lib/storage.mjs';

// Runs once a day and deletes day blobs older than the retention window.
export const config = { schedule: '@daily' };

export default async () => {
  const retentionDays = Number(process.env.RETENTION_DAYS) || 14;
  const removed = await createStorage(getStore('tkcarmonitor')).prune(retentionDays);
  console.log(`prune: removed ${removed} day blobs older than ${retentionDays} days`);
};
