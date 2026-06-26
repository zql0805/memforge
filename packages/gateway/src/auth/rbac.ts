// Created by dev on 2026/04/05
// Copyright © 2026
// 工具级 RBAC 授权

import type { UserRole, ToolPermission, ToolPermissionEntry, ApiKeyScope } from './types.js';

/**
 * 角色权限层级（高权限包含低权限）：
 * admin > lead > developer > viewer
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 4,
  lead: 3,
  developer: 2,
  viewer: 1,
};

/**
 * 权限 → 最低角色要求
 */
const PERMISSION_MIN_ROLE: Record<ToolPermission, UserRole> = {
  read: 'viewer',
  write: 'developer',
  admin: 'admin',
};

/**
 * MCP 工具权限映射表。
 * 对照技术设计文档的授权矩阵：
 * - viewer: 只读工具
 * - developer: 只读 + 写入 + 投票
 * - lead: 只读 + 写入 + 提议 + 投票
 * - admin: 全部
 */
const TOOL_PERMISSIONS: ToolPermissionEntry[] = [
  // Memory Service — 只读
  { tool: 'recall_memory',   permission: 'read',  autoApprove: true },
  { tool: 'list_memories',   permission: 'read',  autoApprove: true },

  // Memory Service — 写入
  { tool: 'store_memory',    permission: 'write', autoApprove: false },
  { tool: 'store_structured_memory', permission: 'write', autoApprove: false },
  { tool: 'update_memory',   permission: 'write', autoApprove: false },
  { tool: 'archive_memory',  permission: 'write', autoApprove: false },
  { tool: 'verify_memory',   permission: 'write', autoApprove: false },
  { tool: 'store_incident',  permission: 'write', autoApprove: false },
  { tool: 'store_log_insight', permission: 'write', autoApprove: false },
  { tool: 'store_troubleshoot', permission: 'write', autoApprove: false },
  { tool: 'store_session_summary', permission: 'write', autoApprove: false },
  { tool: 'store_code_review', permission: 'write', autoApprove: false },

  // Memory Service — 工作上下文追踪
  { tool: 'start_work_context',    permission: 'write', autoApprove: false },
  { tool: 'update_work_context',   permission: 'write', autoApprove: false },
  { tool: 'evaluate_work_context', permission: 'write', autoApprove: false },

  // Memory Service — 文档索引
  { tool: 'index_documents', permission: 'write', autoApprove: false },
  { tool: 'sync_documents',  permission: 'write', autoApprove: false },
  { tool: 'watch_docs',      permission: 'write', autoApprove: false },

  // Memory Service — 学习
  { tool: 'learn_from_commits', permission: 'write', autoApprove: false },
  { tool: 'learn_from_review', permission: 'write', autoApprove: false },

  // Memory Service — 拓扑与管理
  { tool: 'import_topology', permission: 'write', autoApprove: false },
  { tool: 'scan_topology',   permission: 'read',  autoApprove: true },
  { tool: 'query_topology',  permission: 'read',  autoApprove: true },
  { tool: 'get_topology_release_order', permission: 'read', autoApprove: true },
  { tool: 'get_topology_change_impact', permission: 'read', autoApprove: true },
  { tool: 'resolve_service_path', permission: 'read', autoApprove: true },
  { tool: 'check_related_activity', permission: 'read', autoApprove: true },
  { tool: 'bootstrap',       permission: 'admin', autoApprove: false },
  { tool: 'bootstrap_project_history', permission: 'admin', autoApprove: false },
  { tool: 'export_memories', permission: 'read',  autoApprove: true },
  { tool: 'import_memories', permission: 'admin', autoApprove: false },
  { tool: 'get_developer_profile', permission: 'read', autoApprove: true },
  { tool: 'get_system_rules',     permission: 'read', autoApprove: true },
  { tool: 'get_project_context',  permission: 'read', autoApprove: true },
  { tool: 'check_stale_code',     permission: 'read', autoApprove: true },
  { tool: 'check_conflict_risk',  permission: 'read', autoApprove: true },
  { tool: 'index_api_docs',       permission: 'write', autoApprove: false },
  { tool: 'install_git_hooks',    permission: 'write', autoApprove: false },

  // Memory Service — Agent 任务系统
  { tool: 'get_agent_tasks',       permission: 'read',  autoApprove: true },
  { tool: 'create_agent_task',     permission: 'write', autoApprove: false },
  { tool: 'update_agent_task',     permission: 'write', autoApprove: false },
  { tool: 'batch_update_tasks',    permission: 'write', autoApprove: false },
  { tool: 'log_task_progress',     permission: 'write', autoApprove: false },
  { tool: 'import_tasks_from_plan', permission: 'write', autoApprove: false },
  { tool: 'manage_agent_tasks',    permission: 'write', autoApprove: false },


  // Knowledge Service — 只读
  { tool: 'search_knowledge', permission: 'read',  autoApprove: true },
  { tool: 'list_knowledge',   permission: 'read',  autoApprove: true },
  { tool: 'knowledge_stats',  permission: 'read',  autoApprove: true },

  // Knowledge Service — 写入
  { tool: 'store_knowledge',   permission: 'write', autoApprove: false },
  { tool: 'knowledge_feedback', permission: 'write', autoApprove: false },

  // Knowledge Service — VFS 浏览/读取（只读）
  { tool: 'browse_knowledge',     permission: 'read',  autoApprove: true },
  { tool: 'read_knowledge_item',  permission: 'read',  autoApprove: true },

  // Knowledge Service — VFS 写入
  { tool: 'write_knowledge_item', permission: 'write', autoApprove: false },
  { tool: 'import_dingtalk_docs', permission: 'write', autoApprove: false },
  { tool: 'code_context',          permission: 'read',  autoApprove: true },

  // Memory Service — 会话记忆提取
  { tool: 'extract_session_memories', permission: 'write', autoApprove: false },

  // Rules Engine — 只读
  { tool: 'list_rules',      permission: 'read',  autoApprove: true },
  { tool: 'get_rule',        permission: 'read',  autoApprove: true },
  { tool: 'enforce_rules',   permission: 'read',  autoApprove: true },
  { tool: 'measure_rules',   permission: 'read',  autoApprove: true },
  { tool: 'discover_rules',  permission: 'read',  autoApprove: true },
  { tool: 'extract_coding_standards', permission: 'read', autoApprove: true },

  // Rules Engine — 写入
  { tool: 'propose_rule',    permission: 'write', autoApprove: false },
  { tool: 'vote_rule',       permission: 'write', autoApprove: false },
  { tool: 'update_rule',     permission: 'write', autoApprove: false },
  { tool: 'record_rule_event', permission: 'write', autoApprove: false },
  { tool: 'review_commit',  permission: 'write', autoApprove: false },

  // Rules Engine — 管理
  { tool: 'activate_rule',   permission: 'admin', autoApprove: false },
  { tool: 'deprecate_rule',  permission: 'admin', autoApprove: false },
  { tool: 'delete_rule',     permission: 'admin', autoApprove: false },

  // Rules Engine — 技能与知识图谱
  { tool: 'get_skill_radar',      permission: 'read',  autoApprove: true },
  { tool: 'get_team_matrix',      permission: 'read',  autoApprove: true },
  { tool: 'get_knowledge_graph',  permission: 'read',  autoApprove: true },
  { tool: 'add_knowledge_relation', permission: 'write', autoApprove: false },
  { tool: 'record_milestone',     permission: 'write', autoApprove: false },
  { tool: 'assess_skill',         permission: 'write', autoApprove: false },
  { tool: 'get_growth_path',       permission: 'read',  autoApprove: true },
];

const toolPermissionMap = new Map<string, ToolPermissionEntry>();
for (const entry of TOOL_PERMISSIONS) {
  toolPermissionMap.set(entry.tool, entry);
}

export class RBACEnforcer {
  /**
   * 检查用户是否有权限调用指定工具。
   * @returns null 表示允许，string 表示拒绝原因
   */
  checkPermission(role: UserRole, tool: string): string | null {
    const entry = toolPermissionMap.get(tool);
    if (!entry) {
      // 未注册的工具默认拒绝
      return `工具 "${tool}" 未在权限表中注册，拒绝访问`;
    }

    const requiredRole = PERMISSION_MIN_ROLE[entry.permission];
    if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
      return `角色 "${role}" 无权限调用工具 "${tool}"（需要 "${requiredRole}" 或更高角色）`;
    }

    return null;
  }

  /** 获取用户角色能访问的所有工具 */
  getAccessibleTools(role: UserRole): ToolPermissionEntry[] {
    return TOOL_PERMISSIONS.filter(entry => {
      const requiredRole = PERMISSION_MIN_ROLE[entry.permission];
      return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole];
    });
  }

  /** 获取指定工具的权限信息 */
  getToolPermission(tool: string): ToolPermissionEntry | undefined {
    return toolPermissionMap.get(tool);
  }

  /** 判断角色层级是否满足 */
  hasRole(userRole: UserRole, requiredRole: UserRole): boolean {
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
  }

  /**
   * 检查 API Key scope 是否允许调用指定工具。
   * JWT 认证（scope 为 undefined）不受此限制。
   */
  checkApiKeyScope(scope: ApiKeyScope | undefined, tool: string): string | null {
    if (!scope) return null;

    const entry = toolPermissionMap.get(tool);
    if (!entry) return null;

    if (scope === 'read' && entry.permission !== 'read') {
      return `API Key 为只读 scope，无法调用工具 "${tool}"（需要 ${entry.permission} 权限）`;
    }
    if (scope === 'readwrite' && entry.permission === 'admin') {
      return `API Key scope 不足，无法调用管理工具 "${tool}"`;
    }
    return null;
  }
}
