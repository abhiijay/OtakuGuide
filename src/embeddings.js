// src/embeddings.js
// Thin wrapper around @xenova/transformers running Xenova/all-MiniLM-L6-v2.
// Turns a string into a 384-dimensional Float32 vector, packed as a
// 1536-byte Buffer ready to drop into a SQLite BLOB column.
//
// Why this model:
//   - Runs entirely local in Node.js — no API keys, no cost, no rate limit.
//   - ~80MB one-time download on first use, cached in node_modules.
//   - 384 dimensions. Float32 -> 384 * 4 = 1536 bytes per vector. Matches
//     the CHECK(length(...) = 1536) constraint on every vector column in
//     db/schema.sql.
//   - Mean-pooled + L2-normalized output, so cosine similarity reduces
//     to a plain dot product. We still use vec_distance_cosine() in SQL
//     for clarity.
//
// Why dynamic import:
//   @xenova/transformers is an ESM-only package. The rest of the
//   codebase is CommonJS. Wrapping the import in an async function lets
//   us require('./embeddings') from any CJS file without converting
//   the whole project to ESM.
//
// What this file does NOT do:
//   - It does not embed in batches. The first caller (the import script)
//     does one-at-a-time embeddings; if we ever need batched throughput,
//     add embedMany(texts) here, don't sprinkle pipeline calls around.
//   - It does not write to the database. embed(text) returns a Buffer;
//     the caller stores it.

'use strict';

const EMBED_DIM = 384;
const EMBED_BYTES = EMBED_DIM * 4; // Float32 = 4 bytes per dim
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Lazy singleton for the feature-extraction pipeline. First call kicks
// off the ~80MB model download; subsequent calls reuse the loaded model.
// We cache the *promise* (not the resolved pipeline) so concurrent
// callers in the same process all await the same load instead of racing
// to download in parallel.
let pipelinePromise = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', MODEL_ID);
    })();
  }
  return pipelinePromise;
}

// Embeds a string and returns a 1536-byte Buffer (384 Float32s, packed
// little-endian). Throws on empty or non-string input — synopsis-less
// anime are the caller's problem (skip them, or fall back to title).
async function embed(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('embed() requires a non-empty string');
  }

  const extract = await getPipeline();
  const output = await extract(text, { pooling: 'mean', normalize: true });

  // output.data is a Float32Array of length EMBED_DIM. Copy into a
  // standalone Buffer so the caller can store / hash / write it
  // without holding a reference to the model's tensor memory.
  const buf = Buffer.alloc(EMBED_BYTES);
  const view = new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM);
  view.set(output.data);
  return buf;
}

module.exports = { embed, EMBED_DIM, EMBED_BYTES };

// ---------- smoke test ----------
// Run with: node src/embeddings.js
// (1) Verifies the buffer is exactly 1536 bytes (matches schema CHECK).
// (2) Verifies the model produces *meaningful* vectors by checking that
//     two similar anime synopses score high cosine similarity while a
//     third unrelated one scores low. If this fails, the embedding is
//     producing noise even though the byte count looks correct.
if (require.main === module) {
  // Cosine similarity between two embedding Buffers. Used only for the
  // smoke test — production cosine math lives in SQL via sqlite-vec.
  const cosine = (a, b) => {
    const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
    const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < fa.length; i++) {
      dot += fa[i] * fb[i];
      na += fa[i] * fa[i];
      nb += fb[i] * fb[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  (async () => {
    const cowboyBebop =
      'A ragtag crew of bounty hunters travels the solar system in a worn-out spaceship, chasing criminals while wrestling with their own pasts. Jazz, gunfights, and existential melancholy follow them everywhere.';
    const outlawStar =
      'A young pilot inherits an experimental spaceship and assembles a crew of misfits to hunt for a legendary treasure across the galaxy, dodging pirates and rival hunters along the way.';
    const k_on =
      'Four high school girls form a light music club at their academy. They spend afternoons drinking tea, eating cake, and slowly preparing for their first concert.';

    console.log(`Loading ${MODEL_ID} (first run downloads ~80MB)...`);
    const t0 = Date.now();
    await getPipeline();
    console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    console.log('Embedding three sample synopses...');
    const v1 = await embed(cowboyBebop);
    const v2 = await embed(outlawStar);
    const v3 = await embed(k_on);

    console.log(`  byte length: ${v1.length} (expected ${EMBED_BYTES})`);
    if (v1.length !== EMBED_BYTES) {
      throw new Error(`Wrong byte length! Schema CHECK will reject this BLOB.`);
    }
    console.log(`  buffer type: ${v1.constructor.name}`);

    const simBountyHunter = cosine(v1, v2);
    const simSpaceVsSchool = cosine(v1, v3);
    console.log('\nCosine similarities:');
    console.log(
      `  Cowboy Bebop  ↔ Outlaw Star  (both space bounty hunters):  ${simBountyHunter.toFixed(4)}`,
    );
    console.log(
      `  Cowboy Bebop  ↔ K-On!         (space vs. school music):     ${simSpaceVsSchool.toFixed(4)}`,
    );
    console.log(
      `  delta: ${(simBountyHunter - simSpaceVsSchool).toFixed(4)} (positive means model is working)`,
    );

    if (simBountyHunter <= simSpaceVsSchool) {
      throw new Error(
        'Sanity check failed — the model is not distinguishing similar from dissimilar synopses.',
      );
    }
    console.log('\nSmoke test passed.');
  })().catch((err) => {
    console.error('Smoke test failed:', err.message);
    process.exit(1);
  });
}
