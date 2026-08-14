/**
 * Pull the embedding model into the image at build time.
 *
 * Calls the real embedder rather than curling the files, so if an artifact path
 * or revision ever moves the build fails here instead of the container failing
 * at boot in front of a reviewer.
 */

import { EMBEDDING_MODEL, embed } from "../vendor/search/embedder.js";

const started = Date.now();
console.log(`warming ${EMBEDDING_MODEL}…`);
const [vector] = await embed(["warm the onnx session"]);
if (!vector || vector.length === 0) {
  console.error("FATAL: embedder returned no vector");
  process.exit(1);
}
console.log(`  ${vector.length} dims in ${Date.now() - started} ms`);
