import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ASSET_PATH = /^\.\/avatars\/([a-z0-9][a-z0-9-]{0,39}\.glb)$/;
const OUTPUTS = [
  ['../app/lib/identity/avatars.generated.dart', renderDart],
  ['../avatar-core/src/avatar/catalog.generated.ts', renderTs],
];

/** The catalog is the avatar allowlist: reject anything that could widen it silently. */
function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('catalog must be an object');
  if (typeof catalog.defaultId !== 'string' || !catalog.defaultId) throw new Error('defaultId is required');
  if (!Array.isArray(catalog.avatars) || catalog.avatars.length === 0) throw new Error('avatars must not be empty');
  const ids = new Set();
  const paths = new Set();
  for (const [index, option] of catalog.avatars.entries()) {
    const where = `avatars[${index}]`;
    if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error(`${where} must be an object`);
    if (typeof option.id !== 'string' || !ID.test(option.id)) throw new Error(`${where}.id is invalid`);
    if (ids.has(option.id)) throw new Error(`${where}.id is duplicated: ${option.id}`);
    ids.add(option.id);
    if (typeof option.title !== 'string' || !option.title.trim()) throw new Error(`${where}.title is required`);
    if (typeof option.description !== 'string' || !option.description.trim()) throw new Error(`${where}.description is required`);
    if (typeof option.assetPath !== 'string' || !ASSET_PATH.test(option.assetPath)) {
      throw new Error(`${where}.assetPath must be ./avatars/<name>.glb`);
    }
    if (paths.has(option.assetPath)) throw new Error(`${where}.assetPath is duplicated: ${option.assetPath}`);
    paths.add(option.assetPath);
    if (option.body !== 'F' && option.body !== 'M') throw new Error(`${where}.body must be F or M`);
  }
  if (!ids.has(catalog.defaultId)) throw new Error(`defaultId is not in avatars: ${catalog.defaultId}`);
  return catalog;
}

/** Dart string literal: escape backslashes before the characters Dart interpolates. */
function dartString(value) {
  return `'${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('$', '\\$')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`;
}

function renderDart(catalog) {
  const options = catalog.avatars;
  return `// Generated from scripts/avatar-catalog.json. Do not edit by hand.
import 'companion_picker.dart';

class AvatarOption implements PickerOption {
  const AvatarOption({required this.id, required this.title, required this.subtitle, required this.assetPath});
  @override final String id;
  @override final String title;
  @override final String subtitle;
  final String assetPath;
}

const defaultAvatarId = ${dartString(catalog.defaultId)};
const avatarOptions = <AvatarOption>[
${options.map((o) => `  AvatarOption(id: ${dartString(o.id)}, title: ${dartString(o.title)}, subtitle: ${dartString(o.description)}, assetPath: ${dartString(o.assetPath)}),`).join('\n')}
];

AvatarOption avatarOptionFor(String? id) {
  for (final option in avatarOptions) {
    if (option.id == id) return option;
  }
  return avatarOptions.first;
}
bool isAvatarId(String id) => avatarOptions.any((option) => option.id == id);
String avatarUrlFor(String? id) => avatarOptionFor(id).assetPath;
`;
}

function renderTs(catalog) {
  const options = catalog.avatars;
  return `// Generated from scripts/avatar-catalog.json. Do not edit by hand.
export const AVATAR_CATALOG = ${JSON.stringify(options)} as const;
export const DEFAULT_AVATAR_URL: string = AVATAR_CATALOG.find((option) => option.id === ${JSON.stringify(catalog.defaultId)})!.assetPath;
export const ALLOWED_AVATAR_URLS = AVATAR_CATALOG.map(({ assetPath }) => assetPath);
export type AvatarUrl = (typeof AVATAR_CATALOG)[number]['assetPath'];
export function avatarBodyForUrl(url: string): 'F' | 'M' {
  return AVATAR_CATALOG.find((option) => option.assetPath === url)?.body ?? 'F';
}
export function normalizeAvatarUrl(raw: unknown): AvatarUrl | null {
  if (raw === undefined) return DEFAULT_AVATAR_URL as AvatarUrl;
  if (typeof raw !== 'string') return null;
  return (ALLOWED_AVATAR_URLS as readonly string[]).includes(raw) ? raw as AvatarUrl : null;
}
`;
}

const catalog = validateCatalog(JSON.parse(readFileSync(new URL('./avatar-catalog.json', import.meta.url), 'utf8')));
const check = process.argv.includes('--check');
for (const [relative, render] of OUTPUTS) {
  const target = new URL(relative, import.meta.url);
  const expected = render(catalog);
  if (check) {
    const actual = readFileSync(target, 'utf8');
    if (actual !== expected) throw new Error(`generated catalog is stale: ${fileURLToPath(target)}`);
  } else {
    writeFileSync(target, expected);
  }
}
if (check) console.log('avatar catalog is up to date');
