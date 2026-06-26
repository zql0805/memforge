// Created by dev on 2026/06/11

export function isAdminOrLead(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'lead';
}

export function canModifyKnowledgeItem(
  item: { createdBy: string | null },
  userId: string | null,
  userRole: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (isAdminOrLead(userRole)) return true;
  return item.createdBy === userId;
}
