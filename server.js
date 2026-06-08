// OtakuGuide — main server entry point.
// Boots Express, wires EJS templating, serves static files, defines routes.
//
// What's intentionally NOT here yet: sessions, auth, database, API routes.
// Each of those gets added in its own session, with its own dedicated file.

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();

// EJS as the view engine — server-rendered HTML.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve everything under /public at the URL root.
// e.g. public/css/styles.css → http://localhost:3000/css/styles.css
app.use(express.static(path.join(__dirname, 'public')));

// Routes (just one for now — the home page).
app.get('/', (req, res) => {
  res.render('home');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OtakuGuide running at http://localhost:${PORT}`);
});
