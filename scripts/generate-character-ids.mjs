import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE = new URL('../protocol/characters.json', import.meta.url);
const OUTPUTS = [
  ['../protocol/src/characters.generated.ts', renderTs],
  ['../app/lib/identity/character_ids.generated.dart', renderDart],
];
const HEADER = 'Generated from protocol/characters.json by scripts/generate-character-ids.mjs. Do not edit by hand.';

/** The id list is an allowlist shared by gateway and app: reject anything that could widen it silently. */
function validate(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('characters.json must be an object');
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== 'defaultId,ids') throw new Error(`characters.json keys must be exactly ids and defaultId, got: ${keys.join(',')}`);
  if (!Array.isArray(source.ids) || source.ids.length === 0) throw new Error('ids must be a non-empty array');
  const seen = new Set();
  for (const [index, id] of source.ids.entries()) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error(`ids[${index}] is invalid`);
    if (seen.has(id)) throw new Error(`ids[${index}] is duplicated: ${id}`);
    seen.add(id);
  }
  if (typeof source.defaultId !== 'string' || !seen.has(source.defaultId)) throw new Error(`defaultId is not in ids: ${source.defaultId}`);
  return source;
}

// Ids match ID (lowercase ascii, digits, dash), so single quotes never need escaping.
const quoted = (id) => `'${id}'`;

function renderTs(source) {
  return `// ${HEADER}
export const CHARACTER_IDS = [${source.ids.map(quoted).join(', ')}] as const;
export const DEFAULT_CHARACTER_ID: (typeof CHARACTER_IDS)[number] = ${quoted(source.defaultId)};
`;
}

function renderDart(source) {
  return `// ${HEADER}
const characterIds = <String>[${source.ids.map(quoted).join(', ')}];
const defaultCharacterId = ${quoted(source.defaultId)};
`;
}

const source = validate(JSON.parse(readFileSync(SOURCE, 'utf8')));
const check = process.argv.includes('--check');
for (const [relative, render] of OUTPUTS) {
  const target = new URL(relative, import.meta.url);
  const expected = render(source);
  if (check) {
    let actual = '';
    try {
      actual = readFileSync(target, 'utf8');
    } catch {
      throw new Error(`generated character ids are missing: ${fileURLToPath(target)}`);
    }
    if (actual !== expected) throw new Error(`generated character ids are stale: ${fileURLToPath(target)}`);
  } else {
    writeFileSync(target, expected);
  }
}
if (check) console.log('character ids are up to date');
