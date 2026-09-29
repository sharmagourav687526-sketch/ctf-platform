'use strict';

const config = require('../config');

function isConfigured() {
  return !!config.discord.webhookUrl;
}

async function post(payload) {
  if (!isConfigured()) return;
  try {
    await fetch(config.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Discord is best-effort — never crash the solve path over a webhook failure.
  }
}

async function notifySolve({ challenge, who, points, firstBlood }) {
  if (!isConfigured()) return;
  if (config.discord.firstBloodOnly && !firstBlood) return;

  if (firstBlood) {
    await post({
      embeds: [{
        title: '🩸 First Blood!',
        description: `**${who}** got first blood on **${challenge}** for **${points} pts**`,
        color: 0xe53935,
        timestamp: new Date().toISOString(),
      }],
    });
  } else {
    await post({
      content: `🚩 **${who}** solved **${challenge}** (+${points} pts)`,
    });
  }
}

async function notifyAnnouncement({ title, body }) {
  if (!isConfigured()) return;
  await post({
    embeds: [{
      title: `📢 ${title}`,
      description: body.slice(0, 2000),
      color: 0x1e88e5,
      timestamp: new Date().toISOString(),
    }],
  });
}

module.exports = { isConfigured, notifySolve, notifyAnnouncement };
