import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('production image copies only the compiled MCP workspace', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY --from=build \/src\/dist \.\/dist/u);
  assert.doesNotMatch(dockerfile, /next build|drizzle|sqlite|COPY \. \./iu);
});
