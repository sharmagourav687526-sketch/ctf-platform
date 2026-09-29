'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const defaultConfig = require('./config');
const { openDb } = require('./db');
const SqliteStore = require('./sessionStore');
const { context, csrf } = require('./middleware');
const { renderMarkdown, fmtDate } = require('./utils');

function createApp({ db, config = defaultConfig }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Extend CSP to allow Cloudflare Turnstile when a site key is configured.
  const hasCaptcha = !!config.captcha.siteKey;
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: hasCaptcha ? ["'self'", 'https://challenges.cloudflare.com'] : ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        frameSrc: hasCaptcha ? ['https://challenges.cloudflare.com'] : ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
  }));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1h' : 0 }));

  app.use(session({
    name: 'ctf.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new SqliteStore(db),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd && !!config.trustProxy, maxAge: 7 * 24 * 3600 * 1000 },
  }));

  app.locals.fmtDate = fmtDate;
  app.locals.renderMarkdown = renderMarkdown;
  app.locals.captchaSiteKey = config.captcha.siteKey || '';

  app.use(context(db));
  app.use(csrf);

  app.use(require('./routes/scoreboard')(db));
  app.use(require('./routes/auth')(db));
  app.use(require('./routes/challenges')(db, config));
  app.use('/admin', require('./routes/admin')(db, config));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.name === 'MulterError' ? 400 : 500);
    const message = status === 500 ? 'Something went wrong.' : (err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (50 MB max).' : err.message);
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    res.status(status).render('error', { title: 'Error', message });
  });

  return app;
}

if (require.main === module) {
  const db = openDb(defaultConfig.dbFile);
  const app = createApp({ db });
  const server = app.listen(defaultConfig.port, () => {
    console.log(`CTF platform listening on http://localhost:${defaultConfig.port}`);
  });
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
