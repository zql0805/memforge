// Created by dev on 2026/06/12
// Copyright © 2026

import type { MemoryVisibility } from '@memforgeai/shared';
import { getLogger } from '@memforgeai/shared';

const logger = getLogger('visibility-guard');

/** global/product_line 仅 admin/lead 可设，否则降级为 personal */
export function clampVisibilityByRole(
  requested: MemoryVisibility | undefined,
  userRole: string | null,
): MemoryVisibility {
  const visibility = requested ?? 'personal';
  if (
    (visibility === 'global' || visibility === 'product_line') &&
    userRole !== 'admin' &&
    userRole !== 'lead'
  ) {
    logger.warn({ requested: visibility, userRole }, '无权限设置该可见性，已降级为 personal');
    return 'personal';
  }
  return visibility;
}
