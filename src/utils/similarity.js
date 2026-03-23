'use strict';

/**
 * Normalize a title for comparison:
 * - lowercase
 * - remove punctuation and special characters
 * - collapse whitespace
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate character bigrams from a string.
 * Returns an array of two-character strings.
 */
function getBigrams(str) {
  var bigrams = [];
  for (var i = 0; i < str.length - 1; i++) {
    bigrams.push(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Compute Dice coefficient bigram similarity between two title strings.
 * Returns a value between 0.0 (no similarity) and 1.0 (identical).
 *
 * Formula: 2 * |intersection| / (|bigrams_a| + |bigrams_b|)
 *
 * Titles are normalized before comparison (lowercased, punctuation removed,
 * whitespace collapsed).
 */
function titleSimilarity(a, b) {
  var normA = normalize(a);
  var normB = normalize(b);

  if (normA === normB) return 1.0;
  if (normA.length < 2 || normB.length < 2) return 0.0;

  var bigramsA = getBigrams(normA);
  var bigramsB = getBigrams(normB);

  if (bigramsA.length === 0 || bigramsB.length === 0) return 0.0;

  // Build a frequency map for bigramsB so we handle duplicates correctly
  var freqB = new Map();
  for (var i = 0; i < bigramsB.length; i++) {
    var bg = bigramsB[i];
    freqB.set(bg, (freqB.get(bg) || 0) + 1);
  }

  var intersection = 0;
  for (var j = 0; j < bigramsA.length; j++) {
    var bgA = bigramsA[j];
    var count = freqB.get(bgA) || 0;
    if (count > 0) {
      intersection++;
      freqB.set(bgA, count - 1);
    }
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

module.exports = { titleSimilarity, normalize };
