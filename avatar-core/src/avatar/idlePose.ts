/** Resting stance for female avatars. Matches the editor's hand-on-hip preview. */
export const REST_POSE = 'hip';

/** How long the first hip pose takes to settle after the model loads. */
export const REST_POSE_MS = 800;

type PoseLeaf = { delay: [number, number]; vs: { pose: [string] } };

export type PoseAlt = PoseLeaf & { p?: number; M?: PoseLeaf };

/** Happy-mood idle poses. Explicit p values are cumulative chances; the last entry takes the remainder. */
export const HAPPY_IDLE_POSES: readonly PoseAlt[] = [
  { p: 0.55, delay: [5000, 30000], vs: { pose: ['hip'] }, M: { delay: [5000, 30000], vs: { pose: ['side'] } } },
  { p: 0.3, delay: [5000, 30000], vs: { pose: ['straight'] } },
  { p: 0.1, delay: [5000, 30000], vs: { pose: ['side'] } },
  { delay: [5000, 30000], vs: { pose: ['wide'] } },
];

type MoodAnim = { name?: string; idle?: { alt?: unknown[] } };

export type IdlePoseHost = {
  animMoods?: { happy?: { anims?: MoodAnim[] } };
  poseName?: string;
  poseTemplates?: Record<string, unknown>;
  setPoseFromTemplate?: (template: unknown, ms?: number) => void;
};

/** Same coin flip TalkingHead uses when an animation template has `alt`. */
export function pickPoseName(alts: readonly PoseAlt[], coin: number, body: 'F' | 'M'): string {
  let chosen = alts[0];
  if (alts.length > 1) {
    let p = 0;
    for (let i = 0; i < alts.length; i++) {
      const weight = alts[i].p;
      p += weight === undefined ? (1 - p) / (alts.length - 1 - i) : weight;
      if (coin < p) {
        chosen = alts[i];
        break;
      }
    }
  }
  const leaf = body === 'M' && chosen.M ? chosen.M : chosen;
  return leaf.vs.pose[0];
}

/** Replace TalkingHead's happy idle pose list. Safe before the first showAvatar. */
export function applyHappyIdlePoses(head: IdlePoseHost, poses: readonly PoseAlt[] = HAPPY_IDLE_POSES): void {
  const pose = head.animMoods?.happy?.anims?.find((anim) => anim.name === 'pose');
  if (!pose?.idle) return;
  pose.idle.alt = poses.map((alt) => ({ ...alt, vs: { pose: [...alt.vs.pose] as [string] }, M: alt.M ? { ...alt.M, vs: { pose: [...alt.M.vs.pose] as [string] } } : undefined }));
}

/** Snap to the resting stance. Male hip entries already fall back to side inside the idle list. */
export function applyRestPose(head: IdlePoseHost, pose = REST_POSE, ms = REST_POSE_MS): void {
  const template = head.poseTemplates?.[pose];
  if (!template || !head.setPoseFromTemplate) return;
  head.poseName = pose;
  head.setPoseFromTemplate(template, ms);
}
