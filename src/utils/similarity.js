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
 * Compute token-based Dice coefficient similarity between two title strings.
 * Returns a value between 0.0 (no similarity) and 1.0 (identical).
 *
 * Formula: (2 * matchingTokens) / (totalTokensA + totalTokensB)
 *
 * Titles are normalized before comparison (lowercased, punctuation removed,
 * whitespace collapsed), then split into word tokens.
 */
function titleSimilarity(a, b) {
  var normA = normalize(a);
  var normB = normalize(b);

  if (normA === normB) return 1.0;

  var tokensA = normA.split(' ').filter(function(t) { return t.length > 0; });
  var tokensB = normB.split(' ').filter(function(t) { return t.length > 0; });

  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  // Build a frequency map for tokensB so we handle duplicates correctly
  var freqB = new Map();
  for (var i = 0; i < tokensB.length; i++) {
    var tk = tokensB[i];
    freqB.set(tk, (freqB.get(tk) || 0) + 1);
  }

  var matching = 0;
  for (var j = 0; j < tokensA.length; j++) {
    var tkA = tokensA[j];
    var count = freqB.get(tkA) || 0;
    if (count > 0) {
      matching++;
      freqB.set(tkA, count - 1);
    }
  }

  return (2 * matching) / (tokensA.length + tokensB.length);
}

module.exports = { titleSimilarity, normalize };
