const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const config = require('./config');
require('./db');
const { seedAdminUser } = require('./lib/auth');

const stripeWebhookRouter = require('./routes/stripeWebhook');
const licenseRouter = require('./routes/license');
const adminRouter = require('./routes/admin');

async function main() {
  await seedAdminUser();

  const app = express();
  app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Stripe webhook MUST be mounted before express.json() because it needs
  // the raw body for signature verification.
  app.use('/webhooks', stripeWebhookRouter);

  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: 1000 * 60 * 60 * 12,
      },
    }),
  );

  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/api/v1', licenseRouter);
  app.use('/admin', adminRouter);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Internal server error');
  });

  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
