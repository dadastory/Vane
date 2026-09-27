import assert from 'node:assert/strict';
import test from 'node:test';
import { rankResults, retrievalBudgets } from '../src/search.js';

test('registered retrieval modes expose increasing bounded budgets', () => {
  assert.deepEqual(Object.keys(retrievalBudgets), ['speed', 'balanced', 'quality']);
  assert.ok(retrievalBudgets.speed.searchResults < retrievalBudgets.balanced.searchResults);
  assert.ok(retrievalBudgets.balanced.searchResults < retrievalBudgets.quality.searchResults);
  assert.ok(retrievalBudgets.quality.pages <= 5);
});

test('embedding ranking keeps distinct source order by cosine score', () => {
  const ranked = rankResults(
    [1, 0],
    [
      { title: 'low', url: 'https://low.example', content: 'low' },
      { title: 'high', url: 'https://high.example', content: 'high' },
    ],
    [[0, 1], [1, 0]],
  );
  assert.deepEqual(ranked.map((item) => item.title), ['high', 'low']);
});
