import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
const oauth = creds.claudeAiOauth ?? creds.oauth ?? creds;
console.log('cred keys:', Object.keys(creds), '| oauth keys:', Object.keys(oauth));
console.log('expiresAt:', oauth.expiresAt, oauth.expiresAt ? new Date(oauth.expiresAt).toISOString() : '');
const token = oauth.accessToken;

const candidates = [
  'https://api.anthropic.com/api/oauth/usage',
];
for (const url of candidates) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  console.log('\n===', url, '->', res.status);
  console.log((await res.text()).slice(0, 4000));
}
