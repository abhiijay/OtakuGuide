// OtakuGuide — main server entry point.
// Boots Express, wires EJS templating, serves static files, mounts routes.
//
// Routes live in src/routes/ (locked architecture: pages.js for HTML,
// api.js for JSON, auth.js for login/logout — api.js arrives with its feature).

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

const pages = require('./src/routes/pages');
const authRoutes = require('./src/routes/auth');
const apiRoutes = require('./src/routes/api');
const { attachUser, csrf } = require('./src/auth');

// Fail loud on missing config (hard rule). A forge-able default secret is
// exactly the vulnerability the old project shipped — crash instead.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error(
    'FATAL: SESSION_SECRET is not set. Add it to .env before starting.\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
  process.exit(1);
}

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// EJS as the view engine — server-rendered HTML.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve everything under /public at the URL root.
// e.g. public/css/styles.css → http://localhost:3000/css/styles.css
app.use(express.static(path.join(__dirname, 'public')));

// Parse HTML form posts (login/signup) and JSON request bodies (the /api list
// routes). Both run before csrf, which reads req.body for the _csrf field.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Sessions persist in their OWN sqlite file (db/sessions.sqlite), separate
// from the catalog DB — session churn never touches otakuguide.sqlite, and the
// file can be deleted to log everyone out without risking app data. The store
// uses better-sqlite3 (sync), consistent with the rest of the data layer.
const sessionDb = new Database(path.join(__dirname, 'db', 'sessions.sqlite'));
app.use(
  session({
    name: 'og.sid',
    secret: SESSION_SECRET,
    store: new SqliteStore({
      client: sessionDb,
      // Sweep expired sessions every 15 min so the table doesn't grow forever.
      expired: { clear: true, intervalMs: 900000 },
    }),
    resave: false, // store isn't touched unless the session changed
    saveUninitialized: false, // no cookie until there's something to remember
    rolling: true, // refresh maxAge on activity — active users stay logged in
    cookie: {
      httpOnly: true, // JS can't read the cookie (XSS can't steal the session)
      sameSite: 'lax', // CSRF baseline; the csrf token is defense-in-depth
      secure: isProd, // HTTPS-only in production; off on localhost http
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

// CSRF protection (state-changing requests) + load the logged-in user onto
// res.locals for every view. Order matters: session → csrf (reads body) →
// attachUser (reads session) → routes.
app.use(csrf);
app.use(attachUser);

app.use('/', authRoutes);
app.use('/', apiRoutes);
app.use('/', pages);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OtakuGuide running at http://localhost:${PORT}`);
});
