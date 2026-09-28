'use strict';

process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const baseConfig = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');

/** Boot the real app on a random port with an in-memory database. */
async function startServer() {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-uploads-'));
  const db = openDb(':memory:');
  const app = createApp({ db, config: { ...baseConfig, uploadDir, sessionSecret: 'test-secret' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base,
    close: () => new Promise((resolve) => server.close(() => { db.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); resolve(); })),
  };
}

/** Minimal browser-like client: keeps cookies, fetches CSRF tokens, never follows redirects. */
class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }

  async req(method, url, { form, json, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }

  async token() {
    const html = await (await this.req('GET', '/')).text();
    return /name="csrf-token" content="([^"]+)"/.exec(html)[1];
  }

  get(url) { return this.req('GET', url); }

  async post(url, form) {
    return this.req('POST', url, { form: { ...form, _csrf: await this.token() } });
  }

  /** Multipart POST (file uploads). The CSRF token goes in the query string, like the real forms. */
  async multipart(url, fields, files = []) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append('files', new Blob([f.content]), f.name);
    const sep = url.includes('?') ? '&' : '?';
    const h = {};
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${this.base}${url}${sep}_csrf=${encodeURIComponent(await this.token())}`, { method: 'POST', headers: h, body: fd, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }

  async api(url, json = {}) {
    return this.req('POST', url, { json, headers: { 'x-csrf-token': await this.token() } });
  }

  async register(username, password = 'correct-horse-9') {
    return this.post('/register', { username, email: `${username}@example.com`, password, confirm: password });
  }
}

module.exports = { startServer, Client };
