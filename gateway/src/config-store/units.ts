import type { DescriptorItem } from './descriptors.ts';
import type { OverlayValue } from './keys.ts';

/** Stored units per display unit. Only ms needs converting; days, counts and chars are stored as shown. */
function factor(item: DescriptorItem): number {
  if (item.storageUnit !== 'ms') return 1;
  if (item.unit === 'second') return 1_000;
  if (item.unit === 'minute') return 60_000;
  throw new Error(`descriptor_unit_unsupported:${item.key}`);
}

export function toDisplay(item: DescriptorItem, stored: OverlayValue): OverlayValue {
  return item.control === 'number' && typeof stored === 'number' ? stored / factor(item) : stored;
}

export function toStored(item: DescriptorItem, display: OverlayValue): OverlayValue {
  return item.control === 'number' && typeof display === 'number' ? Math.round(display * factor(item)) : display;
}
