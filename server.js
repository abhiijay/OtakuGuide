// OtakuGuide — main server entry point.
// Boots Express, wires EJS templating, serves static files, mounts routes.
//
// Routes live in src/routes/ (locked architecture: pages.js for HTML,
// api.js for JSON, auth.js for login/logout — the latter two arrive with
// their features). What's intentionally NOT here yet: sessions, auth.

require('dotenv').config();

const express = require('express');
const path = require('path');
const pages = require('./src/routes/pages');

const app = express();

// EJS as the view engine — server-rendered HTML.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve everything under /public at the URL root.
// e.g. public/css/styles.css → http://localhost:3000/css/styles.css
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', pages);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OtakuGuide running at http://localhost:${PORT}`);
});
