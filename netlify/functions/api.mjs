import { getStore } from '@netlify/blobs';
import { handleRequest } from './lib/api.mjs';
import { createStorage } from './lib/storage.mjs';

export const config = { path: '/api/*' };

export default async (req) =>
  handleRequest(req, {
    storage: createStorage(getStore('tkcarmonitor')),
    deviceToken: process.env.DEVICE_TOKEN,
    dashboardToken: process.env.DASHBOARD_TOKEN,
    retentionDays: Number(process.env.RETENTION_DAYS) || 14,
  });
