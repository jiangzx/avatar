import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, targetPath, transformArg] = process.argv.slice(2);
if (!sourcePath || !targetPath) throw new Error('usage: derive-avatar-variant.mjs <source.glb> <target.glb>');
const transform = transformArg ? JSON.parse(transformArg) : { armatureScale: 0.9, headScale: 1.08 };

const input = readFileSync(sourcePath);
if (input.readUInt32LE(0) !== 0x46546c67 || input.readUInt32LE(4) !== 2) throw new Error('invalid GLB');

const jsonLength = input.readUInt32LE(12);
const json = JSON.parse(input.subarray(20, 20 + jsonLength).toString('utf8').trim());
const armature = json.nodes?.find((node) => node.name === 'Armature');
const head = json.nodes?.find((node) => node.name === 'Head');
if (!armature || !head) throw new Error('source avatar has no expected skeleton');

// Keep the source's facial blendshapes and rig while changing proportions from the manifest.
const armatureScale = Number(transform.armatureScale);
const headScale = Number(transform.headScale);
if (!Number.isFinite(armatureScale) || !Number.isFinite(headScale) || armatureScale <= 0 || headScale <= 0) {
  throw new Error('invalid transform');
}
armature.scale = [armatureScale, armatureScale, armatureScale];
head.scale = [headScale, headScale, headScale];
json.asset = { ...json.asset, extras: { ...(json.asset?.extras ?? {}), derivedVariant: true, armatureScale, headScale } };

const jsonBytes = Buffer.from(JSON.stringify(json));
const paddedJson = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
const jsonChunk = Buffer.alloc(8 + paddedJson.length);
jsonChunk.writeUInt32LE(paddedJson.length, 0);
jsonChunk.writeUInt32LE(0x4e4f534a, 4); // JSON
Buffer.from(paddedJson).copy(jsonChunk, 8);

const binaryChunk = input.subarray(20 + jsonLength);
const output = Buffer.alloc(12 + jsonChunk.length + binaryChunk.length);
output.writeUInt32LE(0x46546c67, 0);
output.writeUInt32LE(2, 4);
output.writeUInt32LE(output.length, 8);
jsonChunk.copy(output, 12);
binaryChunk.copy(output, 12 + jsonChunk.length);
writeFileSync(targetPath, output);
