import { palette } from '../theme.ts';

export interface InlineBarProps { value: number; max: number; tone?: 'normal' | 'danger'; color?: string }

/** Thin bar next to a number showing its size relative to the column maximum. Decorative: the number carries the value. */
export function InlineBar({ value, max, tone = 'normal', color }: InlineBarProps) {
  const percent = max > 0 && value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const background = tone === 'danger' ? palette.cinnabar : color ?? palette.celadon;
  return (
    <span className="inline-bar" aria-hidden="true">
      <span data-testid="inline-bar-fill" data-tone={tone} style={{ width: `${percent}%`, background }} />
    </span>
  );
}
