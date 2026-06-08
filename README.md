# OtakuGuide

A minimalist anime tracker and recommender, inspired by Kenmei's approach to manga.
Built as a side project to actually understand each piece, not vibe-code through it.

## What it is

OtakuGuide tracks the anime you watch and recommends what to watch next.
It syncs with AniList so your existing list comes with you.

## What it represents

Anime is one of the most genre-blurred mediums in the world. Most trackers
treat it like a checklist. OtakuGuide treats it like a quiet, ink-on-paper
journal — minimalist, fast, and respectful of the medium it indexes.
Black, white, and a single stroke of sakura red, in the spirit of Japanese
sumi-e ink painting.

## Why this exists

A previous iteration of this project was vibe-coded — built without
understanding what each part was doing. The result was ~30 dead or broken
pieces and a "recommendation engine" that was genre-substring matching
pretending to be ML. This rebuild starts over from clean foundations,
with every file earning its place and every algorithm understood line by line.

## Project status (as of 2026-06-06)

**Nothing is built yet.** Only documentation exists on disk:

- `README.md` (this file)
- `CLAUDE.md` (technical context, auto-loaded by Claude in this project)

No source code, no `package.json`, no `node_modules`, no database. The folder is intentionally minimal until planning is finalized.

If you're picking this back up after time away, see "How to resume" near the bottom.

## Stack

- **Node.js + Express** — web server
- **EJS** — server-rendered HTML templates
- **Tailwind CSS** — utility-first styling, compiled locally (no CDN)
- **SQLite via better-sqlite3** — single-file database, zero config
- **AniList API** — OAuth login + sync your existing anime list

## File map

Roughly 25 files at completion. Each one earns its place.

| Path | Purpose |
| --- | --- |
| `server.js` | The on switch — boots Express, mounts middleware and routes |
| `package.json` | Dependencies and npm scripts |
| `.env` / `.env.example` | Secrets (gitignored) and template |
| `tailwind.config.js` | Design system — sakura color, fonts, spacing |
| `postcss.config.js` | Plumbing Tailwind needs |
| `styles/input.css` | 3-line Tailwind source |
| `public/css/styles.css` | Compiled Tailwind, served to the browser |
| `public/js/app.js` | Small client-side helper (one file) |
| `public/images/` | Logo, favicon, fallback poster |
| `public/fonts/` | Optional self-hosted Japanese font |
| `db/schema.sql` | Database structure, readable SQL with comments |
| `db/seed.sql` | Sample anime for dev |
| `db/otakuguide.sqlite` | The DB file (auto-created, gitignored) |
| `src/db.js` | Opens SQLite, exports the handle |
| `src/auth.js` | Sessions, password hashing, middleware |
| `src/anilist.js` | AniList OAuth + GraphQL |
| `src/recommender.js` | The recommendation engine |
| `src/routes/pages.js` | HTML page routes |
| `src/routes/api.js` | JSON endpoints |
| `src/routes/auth.js` | Login, register, logout, AniList callback |
| `views/layout.ejs` | Page wrapper (head, body shell) |
| `views/partials/header.ejs` | Top navigation |
| `views/partials/footer.ejs` | Minimal footer |
| `views/home.ejs` | Landing page |
| `views/browse.ejs` | Search and discover |
| `views/anime.ejs` | Single anime detail |
| `views/list.ejs` | Your tracked list (Kenmei-style table) |
| `views/recommendations.ejs` | Personalized recs |
| `views/login.ejs` / `register.ejs` | Auth forms |
| `views/settings.ejs` | Profile + AniList connect |
| `scripts/init-db.js` | Creates the database tables |
| `scripts/import-anime.js` | Pulls anime catalog from AniList |

## Running it (once the code exists)

1. Clone the repo and `cd OtakuGuide`
2. `npm install`
3. `cp .env.example .env` and fill in `SESSION_SECRET` + AniList OAuth credentials
4. `npm run init-db` — creates the SQLite tables
5. `npm run import-anime` — pulls the anime catalog from AniList (one-time)
6. `npm run dev` — starts the dev server at http://localhost:3000

## Theme

- **Palette**: black, white, three grays, and **sakura red** (vermillion, target ~`#DC143C`–`#E03C42`).
- **Inspiration**: Japanese sumi-e ink painting — ink-brush motifs, paper backgrounds, optional kanji watermarks (桜 / アニメ).
- **Hover state**: nav tabs are black/white in repose, sakura red on hover/active.
- **Typography**: clean serif for headings (considering Shippori Mincho or Noto Serif JP), system sans for body.

## The recommendation engine

Built on local sentence embeddings (`Xenova/all-MiniLM-L6-v2` running inside
Node.js — no API key, no cost) with vectors stored in SQLite via the
`sqlite-vec` extension. Twelve signals feed into the engine at v1, each
addressable independently so the UI can expose **faceted weighting** —
sliders for "similar story / similar characters / similar tone / similar style."

### Signals used (v1)

- Synopsis embedding (meaning-level similarity, not keyword match)
- AniList tags (TF-IDF — rare tags weighted higher)
- Genre, studio, era, episode count, source material, format
- Character vectors (averaged main-cast embeddings — for "characters like Naruto")
- Review-aggregate vector (captures humor and tone from community discourse)
- Mean score & popularity (used only for re-ranking, not similarity)
- Relations graph (filters sequels/prequels out of "discover" results)

### Recommender-theory features (v1)

- Cosine similarity as the core comparison
- **Serendipity** boost — inverse popularity weighting + cross-genre bridging
- **Diversity** re-ranking — spread across studios / eras / genres
- **Cold start** handling — onboarding quiz + popularity fallback
- **Explainability** — every rec shows "Why this?"
- **Implicit feedback** — episode progress, drops, completions all feed back
- **Negative signals** — dropped anime push your taste vector away
- **Matrix factorization** for collaborative filtering as community grows
- **Community-curated** AniList recommendations ingested as one signal

### Deferred to v2

- LLM tone tagging (humor style, mood arc, intensity)
- Vision embeddings via CLIP for "similar animation style"
- Time decay on user ratings

See `CLAUDE.md` for the complete signal inventory with sourcing, weights,
and explicit exclusions (and why).

## Roadmap

- **v1** — Full recommender as described above + AniList sync + tracker UI + faceted query weighting
- **v2** — LLM tone tagging + CLIP visual embeddings + time decay
- **v3** (optional) — One Claude-powered free-text rec feature ("find me something like X but Y")

## Decisions and reasoning (short version)

The full decisions log with reasoning lives in `CLAUDE.md`. Headlines:

- **Greenfield rebuild** of a vibe-coded project at `ALTIER/Anime-Recommender` (~30 broken or dead items, recommender was genre-substring matching pretending to be ML)
- **Node + Express + EJS + Tailwind + SQLite** — boring is the point. The code must be readable.
- **`sqlite-vec` extension** for vector queries — keeps everything in one SQLite file, avoids running a separate vector DB
- **AniList API** for sync — Crunchyroll and Netflix have no public consumer API
- **Local sentence embeddings** (`Xenova/all-MiniLM-L6-v2`) — free, no API keys, runs inside Node
- **Drop title from embeddings** — stylized romanizations are noise; synopsis covers what matters
- **Faceted vectors** (synopsis, characters, reviews, etc.) — enables UI weighting sliders
- **12 signals in v1, no gaps** — the full recommender ships at launch, not staged
- **Sakura red + Japanese sumi-e** aesthetic, explicitly evolvable
- **Compiled Tailwind, no CDN** — the old project's #1 mistake
- **Fail loud on missing config** — the old project's #2 mistake (default session secret)

## How to resume

If you're picking this up after a break:

1. **Read this file first.** Re-orient on what OtakuGuide is and the status.
2. **Then read `CLAUDE.md` in full.** Don't skip — it has the full decisions log, hard rules, and signal inventory. You will forget details otherwise.
3. **Review "Open decisions"** in `CLAUDE.md`. Confirm or revise each one before writing code.
4. **First code to write** is the file scaffold: `package.json`, `server.js`, Tailwind config, `db/schema.sql`, `.env.example`. No real logic — just the bones. Get `npm install` clean and `npm run dev` to boot a blank "hello world" page with compiled Tailwind. Don't add features until that boot loop works.
5. **Then build features in order:** auth → AniList OAuth flow → catalog import → tracker UI → recommender. Don't jump ahead.

The Claude memory system also has project context auto-loaded — including a note that the design direction is **open to evolution**. If you've found new aesthetic inspiration since you last worked on this, tell Claude and the memory will be updated.

## Notes for future contributors (human or AI)

See `CLAUDE.md` for hard rules and architectural guardrails. Read it before
making changes — it lists specific things to never do (no CDN Tailwind, no
global CSS hacks, no fake features, etc.) that were lessons learned from
the previous vibe-coded iteration.
