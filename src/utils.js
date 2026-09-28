'use strict';

const crypto = require('crypto');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tiny, safe Markdown subset for challenge text: fenced code, `inline code`, **bold**,
 * *italic*, [links](http...) and paragraphs. Input is HTML-escaped FIRST, so nothing
 * an admin types can inject markup beyond the tags generated here.
 */
function renderMarkdown(text) {
  const blocks = [];
  let src = escapeHtml(text || '').replace(/\r\n/g, '\n');

  src = src.replace(/```(?:[\w-]*)\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const html = src
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => (/^\u0000\d+\u0000$/.test(para) ? para : `<p>${inline(para).replace(/\n/g, '<br>')}</p>`))
    .join('\n');

  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

/** Escape a CSV cell, neutralising spreadsheet formula injection (=, +, -, @). */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** Parse an epoch-millisecond form field; '' -> '' (unset), invalid -> null. */
function parseEpoch(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null;
}

module.exports = { escapeHtml, renderMarkdown, csvCell, toCsv, randomHex, fmtDate, parseEpoch };
