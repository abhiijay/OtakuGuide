-- OtakuGuide schema.
-- Executed by scripts/init-db.js.
--
-- Layout (15 tables in 5 groups; see CLAUDE.md "Where we left off"):
--   Group 1 of 5 — Auth                  (users, external_accounts)            [done]
--   Group 2 of 5 — Catalog spine         (anime)                               [done]
--   Group 3 of 5 — Lookups + joins       (genres/tags/studios/characters +4)   [done]
--   Group 4 of 5 — Relationships         (relations, community_recommendations)[done]
--   Group 5 of 5 — User behavior         (user_anime, user_vectors)            [done]
--
-- Conventions:
--   * Timestamps are ISO-8601 TEXT in UTC ("2026-06-08T20:14:00Z").
--   * No updated_at columns — easier to forget than to maintain. Add when needed.
--   * Boolean flags use INTEGER with explicit DEFAULT.
--   * Every column has an inline comment explaining its purpose.

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Group 1 of 5 — Auth
-- ============================================================================

-- users — one row per registered OtakuGuide account.
-- Login can be email/password OR AniList OAuth.
-- AniList-only accounts have password_hash = NULL; login code treats them
-- as "OAuth-only" and disables the password form for that email.
CREATE TABLE IF NOT EXISTS users (
  id                       INTEGER PRIMARY KEY,
  email                    TEXT    NOT NULL UNIQUE,    -- login identity; app code lowercases before insert/lookup
  password_hash            TEXT,                       -- bcrypt; NULL for OAuth-only accounts
  username                 TEXT    NOT NULL UNIQUE,    -- display name shown in header, settings, future profile pages
  created_at               TEXT    NOT NULL,           -- ISO-8601 UTC; set once at signup
  last_seen_at             TEXT,                       -- updated on each login; NULL until first login after signup
  onboarding_completed_at  TEXT,                       -- cold-start quiz completion; NULL = recommender uses popularity fallback
  is_active                INTEGER NOT NULL DEFAULT 1  -- soft-delete flag (1 = active, 0 = disabled)
);

-- external_accounts — OAuth links to third-party services.
-- A user can connect zero or more providers; the same provider can only be
-- linked once per user (enforced by UNIQUE (user_id, provider) below).
CREATE TABLE IF NOT EXISTS external_accounts (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL,    -- FK -> users.id; cascade so a deleted user's tokens are removed
  provider          TEXT    NOT NULL,    -- 'anilist' (v1) | 'mal' | 'kitsu' (future)
  provider_user_id  TEXT    NOT NULL,    -- the user's ID at the provider (TEXT so future UUID-based providers fit)
  access_token      TEXT    NOT NULL,    -- OAuth access token; AniList tokens are ~600 chars
  expires_at        TEXT,                -- ISO-8601 expiry; NULL = unknown / non-expiring
  connected_at      TEXT    NOT NULL,    -- when the user linked this provider
  last_synced_at    TEXT,                -- when we last pulled their list; NULL = never synced

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, provider)
);

-- Lookup: "which OtakuGuide user owns AniList account 12345?"
-- Used during OAuth callback to recognize returning users vs. first-time linkers.
-- (The UNIQUE constraints above already create indices for email, username,
-- and (user_id, provider) — those don't need explicit CREATE INDEX statements.)
CREATE INDEX IF NOT EXISTS idx_external_accounts_provider_user
  ON external_accounts(provider, provider_user_id);

-- ============================================================================
-- Group 2 of 5 — Catalog spine
-- ============================================================================

-- anime — one row per imported title.
--
-- Two source IDs are stored from day one so we can swap or merge providers
-- later without a migration (see CLAUDE.md "Data sourcing & resilience").
-- v1 only imports from AniList, filtered to Japan-only at import time
-- (country_of_origin not stored — adding when we expand to donghua/aeni).
--
-- Embedding vectors are Float32 little-endian, stored as BLOB.
-- 384-d vectors (synopsis/tag/character/review) = 1536 bytes; enforced by CHECKs.
-- collab_vec is left dimension-flexible (SVD tuning may change it from 32 to 64+).
-- Brute-force cosine via vec_distance_cosine() is sub-millisecond at ~30K rows;
-- if we ever outgrow that, mirror into vec0 virtual tables.
CREATE TABLE IF NOT EXISTS anime (
  id                INTEGER PRIMARY KEY,

  -- Identity (multi-source resilience)
  anilist_id        INTEGER UNIQUE,             -- AniList Media.id; primary source in v1
  mal_id            INTEGER UNIQUE,             -- MyAnimeList ID; populated when available, NULL otherwise

  -- Display titles (NOT used in similarity embeddings — see CLAUDE.md "Title not in synopsis embedding")
  title_romaji      TEXT,                       -- "Shingeki no Kyojin"; almost always present
  title_english     TEXT,                       -- "Attack on Titan"; often NULL for niche titles
  title_native      TEXT,                       -- "進撃の巨人"; Japanese script
  synonyms          TEXT,                       -- JSON array of alt titles from AniList ("AoT", "SnK"); used for search

  -- Visuals (URLs to AniList CDN; we don't host images)
  cover_image_url   TEXT,                       -- portrait poster
  banner_image_url  TEXT,                       -- wide banner; NULL ≈30-40% of titles; view layer falls back to a sumi-e placeholder

  -- Synopsis (stored with AniList's HTML markup; stripped before embedding, sanitized before display)
  synopsis          TEXT,                       -- input to synopsis_vec

  -- Categorical signals (Sub-group C — see CLAUDE.md signal inventory #5-#8)
  format            TEXT,                       -- 'TV' | 'MOVIE' | 'OVA' | 'SPECIAL' | 'ONA' | 'MUSIC' | 'TV_SHORT' — signal #8
  source            TEXT,                       -- 'MANGA' | 'LIGHT_NOVEL' | 'ORIGINAL' | 'GAME' | 'WEB_NOVEL' | etc. — signal #7
  episodes          INTEGER,                    -- count; NULL while status='RELEASING' — signal #6 (buckets derived in code)
  duration_minutes  INTEGER,                    -- per-episode runtime; powers "short-form" filter
  season            TEXT,                       -- 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; NULL for movies/specials
  season_year       INTEGER,                    -- e.g. 2023 — signal #5 (era)
  status            TEXT,                       -- 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS'

  -- Quality / popularity (Sub-group D — RE-RANKING ONLY, never inputs to similarity vectors — signal #11)
  average_score     REAL,                       -- AniList averageScore 0-100 (vote-count weighted); NULL if too few ratings
  popularity        INTEGER,                    -- AniList popularity count (users tracking it)

  -- Filter flag (decision 2026-06-08: filter centralized in src/db.js, no user toggle)
  is_adult          INTEGER NOT NULL DEFAULT 0, -- AniList isAdult (explicit sexual content only; gore/violence don't trigger it)

  -- Embedding vectors (Float32 little-endian; populated by the embedding worker after metadata import)
  synopsis_vec      BLOB,                       -- 384-d — signal #1
  tag_vec           BLOB,                       -- 384-d (TF-IDF weighted tag pool) — signal #2
  character_vec     BLOB,                       -- 384-d (avg of main-cast description embeddings) — signal #9
  review_vec        BLOB,                       -- 384-d (avg of review-text embeddings) — signal #10
  collab_vec        BLOB,                       -- ~32-d SVD latent factor; populated by periodic batch job, not at import

  -- Bookkeeping
  created_at        TEXT NOT NULL,              -- when row was inserted into our DB; ISO-8601 UTC
  synced_at         TEXT,                       -- when we last refreshed from source; NULL only between insert and first sync

  -- Dimension assertions: catch import bugs early. 384 floats × 4 bytes = 1536.
  CHECK (synopsis_vec  IS NULL OR length(synopsis_vec)  = 1536),
  CHECK (tag_vec       IS NULL OR length(tag_vec)       = 1536),
  CHECK (character_vec IS NULL OR length(character_vec) = 1536),
  CHECK (review_vec    IS NULL OR length(review_vec)    = 1536)
);

-- ============================================================================
-- Group 3 of 5 — Lookups + joins
-- ============================================================================
-- 4 lookup tables (genres / tags / studios / characters)
--   + 4 join tables (anime_genres / anime_tags / anime_studios / anime_characters)
-- Powers signals #2 (tags TF-IDF), #3 (genre one-hot), #4 (studio), #9 (characters).

-- genres — AniList's ~20 fixed broad categories.
CREATE TABLE IF NOT EXISTS genres (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE       -- 'Action' | 'Adventure' | 'Comedy' | ... (~20 total)
);

-- tags — AniList's ~300 community-curated, ranked descriptors.
CREATE TABLE IF NOT EXISTS tags (
  id              INTEGER PRIMARY KEY,
  anilist_tag_id  INTEGER UNIQUE,             -- AniList's tag ID; lets us re-sync without name matching
  name            TEXT    NOT NULL UNIQUE,    -- 'Iyashikei', 'Time Skip', 'Found Family'
  description     TEXT,                       -- AniList's short blurb explaining what the tag means (for tooltips)
  category        TEXT,                       -- 'Theme-Action-Combat' | 'Setting-Universe' | 'Demographic' | etc.
  is_adult        INTEGER NOT NULL DEFAULT 0  -- some tags are adult-only (rare; mostly explicit-content category)
);

-- studios — animation studios + licensors/producers.
CREATE TABLE IF NOT EXISTS studios (
  id                  INTEGER PRIMARY KEY,
  anilist_studio_id   INTEGER UNIQUE,             -- re-sync key
  name                TEXT    NOT NULL UNIQUE,    -- 'ufotable', 'Kyoto Animation', 'MAPPA'
  is_animation_studio INTEGER NOT NULL DEFAULT 1  -- 1 = animation studio (used in signal #4); 0 = licensor/producer (display only)
);

-- characters — one row per character. description_vec is the per-character
-- embedding; we average MAIN-role characters per anime into anime.character_vec.
CREATE TABLE IF NOT EXISTS characters (
  id                    INTEGER PRIMARY KEY,
  anilist_character_id  INTEGER UNIQUE,         -- re-sync key
  name                  TEXT,                   -- full name, e.g. 'Naruto Uzumaki' (AniList's name.full)
  name_native           TEXT,                   -- Japanese script ('うずまき ナルト')
  description           TEXT,                   -- bio; input to description_vec
  image_url             TEXT,                   -- portrait URL on AniList CDN
  description_vec       BLOB,                   -- 384-d Float32; signal #9 averages these per anime
  created_at            TEXT NOT NULL,          -- when row was inserted into our DB
  synced_at             TEXT,                   -- when we last refreshed from AniList

  CHECK (description_vec IS NULL OR length(description_vec) = 1536)
);

-- ----- Join tables (many-to-many between anime and the lookups above) -----

-- anime_genres — composite PK prevents duplicate genre attachment per anime.
CREATE TABLE IF NOT EXISTS anime_genres (
  anime_id  INTEGER NOT NULL,
  genre_id  INTEGER NOT NULL,
  PRIMARY KEY (anime_id, genre_id),
  FOREIGN KEY (anime_id) REFERENCES anime(id)  ON DELETE CASCADE,
  FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
);

-- anime_tags — rank drives TF-IDF weighting (signal #2) AND the
-- "show tags with rank >= 60 by default" display rule on the detail page.
CREATE TABLE IF NOT EXISTS anime_tags (
  anime_id            INTEGER NOT NULL,
  tag_id              INTEGER NOT NULL,
  rank                INTEGER NOT NULL,            -- AniList's 0-100 relevance score (community-voted)
  is_general_spoiler  INTEGER NOT NULL DEFAULT 0,  -- hide on detail page until user opts in
  is_media_spoiler    INTEGER NOT NULL DEFAULT 0,  -- spoilers specific to this medium adaptation
  PRIMARY KEY (anime_id, tag_id),
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)   REFERENCES tags(id)  ON DELETE CASCADE
);

-- anime_studios — is_main flag picks out the animation studio for signal #4;
-- other studios (licensors, co-producers) come along for display.
CREATE TABLE IF NOT EXISTS anime_studios (
  anime_id   INTEGER NOT NULL,
  studio_id  INTEGER NOT NULL,
  is_main    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (anime_id, studio_id),
  FOREIGN KEY (anime_id)  REFERENCES anime(id)   ON DELETE CASCADE,
  FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
);

-- anime_characters — role drives signal #9 (we average MAIN-role characters
-- per anime to build anime.character_vec).
CREATE TABLE IF NOT EXISTS anime_characters (
  anime_id      INTEGER NOT NULL,
  character_id  INTEGER NOT NULL,
  role          TEXT    NOT NULL,    -- 'MAIN' | 'SUPPORTING' | 'BACKGROUND'
  PRIMARY KEY (anime_id, character_id),
  FOREIGN KEY (anime_id)     REFERENCES anime(id)      ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);

-- ============================================================================
-- Group 4 of 5 — Relationships
-- ============================================================================
-- Two anime-to-anime many-to-many tables.
--   relations                — sequel/prequel/spin-off graph (signal #12, FILTER)
--   community_recommendations — AniList's "if you liked X, watch Y" pairs (one
--                               additional signal in the recommender)

-- relations — sequel/prequel/spin-off/etc. graph from AniList.
-- Used by the re-ranking pass to EXCLUDE franchise duplicates from "discover"
-- results (we don't recommend AoT S2 to someone who just finished AoT S1).
-- AniList exposes both directions of each relation; we store both rows so
-- a forward FK lookup from anime_id always finds everything.
-- relation_type values: SEQUEL | PREQUEL | PARENT | SIDE_STORY | ALTERNATIVE
--                       SPIN_OFF | SUMMARY | COMPILATION | CONTAINS | CHARACTER | OTHER
-- (ADAPTATION / SOURCE are skipped at import — they point to manga/LN, not anime.)
CREATE TABLE IF NOT EXISTS relations (
  anime_id          INTEGER NOT NULL,
  related_anime_id  INTEGER NOT NULL,
  relation_type     TEXT    NOT NULL,
  PRIMARY KEY (anime_id, related_anime_id, relation_type),
  FOREIGN KEY (anime_id)         REFERENCES anime(id) ON DELETE CASCADE,
  FOREIGN KEY (related_anime_id) REFERENCES anime(id) ON DELETE CASCADE
);

-- community_recommendations — AniList's user-submitted "if you liked X, watch Y"
-- pairs. Ingested as one signal among many in the recommender; pairs with
-- higher community ratings get more weight.
-- Direction matters: "X -> Y" doesn't imply "Y -> X". We store each direction
-- AniList provides as its own row.
CREATE TABLE IF NOT EXISTS community_recommendations (
  anime_id              INTEGER NOT NULL,
  recommended_anime_id  INTEGER NOT NULL,
  rating                INTEGER NOT NULL,  -- AniList net votes (upvotes - downvotes); can be negative
  PRIMARY KEY (anime_id, recommended_anime_id),
  FOREIGN KEY (anime_id)             REFERENCES anime(id) ON DELETE CASCADE,
  FOREIGN KEY (recommended_anime_id) REFERENCES anime(id) ON DELETE CASCADE
);

-- ============================================================================
-- Group 5 of 5 — User behavior
-- ============================================================================
-- user_anime    — the watch list (one row per user × anime); feeds implicit
--                 feedback, negative signals, already-watched filtering, the
--                 cold-start quiz seeding, and the SVD ratings matrix.
-- user_vectors  — the derived taste profile (one row per user); per-signal
--                 net taste vectors + SVD latent factor.

-- user_anime — the watch list.
-- EXCEPTION to the "no updated_at" rule: this table is mutated constantly
-- (every progress / score / status change). updated_at powers the "recently
-- updated" sort and the recomputation worker's staleness check. Centralize
-- writes through a helper in src/db.js so we can't forget to set it.
CREATE TABLE IF NOT EXISTS user_anime (
  user_id           INTEGER NOT NULL,
  anime_id          INTEGER NOT NULL,
  status            TEXT    NOT NULL,             -- 'WATCHING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'PLANNING' | 'REWATCHING'
  score             INTEGER,                      -- 0-100 internal scale; NULL = watched but didn't rate
  episodes_watched  INTEGER NOT NULL DEFAULT 0,   -- progress; for status='DROPPED' this also IS the drop-point signal
  rewatched_count   INTEGER NOT NULL DEFAULT 0,   -- finished rewatches; stronger positive signal than COMPLETED
  is_favorite       INTEGER NOT NULL DEFAULT 0,   -- user-marked favorite; strongest positive signal
  started_at        TEXT,                         -- ISO-8601; NULL until they begin watching
  finished_at       TEXT,                         -- ISO-8601; NULL until COMPLETED
  notes             TEXT,                         -- private notes
  created_at        TEXT NOT NULL,                -- when this entry was added to the list
  updated_at        TEXT NOT NULL,                -- when this row was last modified (see exception note above)

  PRIMARY KEY (user_id, anime_id),
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (anime_id) REFERENCES anime(id) ON DELETE CASCADE,

  CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  CHECK (episodes_watched >= 0),
  CHECK (rewatched_count  >= 0)
);

-- user_vectors — derived taste profile (one row per user).
-- Refreshed by a batch worker after the user updates their list.
-- Each *_taste_vec is the net of liked-anime mean minus λ × disliked-anime mean
-- on the corresponding facet, so cosine(user_vec, anime_vec) is one cheap
-- lookup per signal at query time.
CREATE TABLE IF NOT EXISTS user_vectors (
  user_id              INTEGER PRIMARY KEY,
  synopsis_taste_vec   BLOB,            -- 384-d Float32 — facet of signal #1
  tag_taste_vec        BLOB,            -- 384-d Float32 — facet of signal #2
  character_taste_vec  BLOB,            -- 384-d Float32 — facet of signal #9
  review_taste_vec     BLOB,            -- 384-d Float32 — facet of signal #10
  collab_vec           BLOB,            -- ~32-d SVD user latent factor; populated by periodic batch
  created_at           TEXT NOT NULL,   -- typically set right after onboarding quiz completion
  recomputed_at        TEXT,            -- when vectors were last refreshed; NULL = never recomputed yet

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

  CHECK (synopsis_taste_vec  IS NULL OR length(synopsis_taste_vec)  = 1536),
  CHECK (tag_taste_vec       IS NULL OR length(tag_taste_vec)       = 1536),
  CHECK (character_taste_vec IS NULL OR length(character_taste_vec) = 1536),
  CHECK (review_taste_vec    IS NULL OR length(review_taste_vec)    = 1536)
);
