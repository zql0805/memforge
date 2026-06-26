// Created by dev on 2026/04/05
// Copyright © 2026
// 技能树与知识图谱数据访问层

import type { Pool } from 'pg';
import type {
  SkillDefinition,
  UserSkill,
  SkillEvidence,
  SkillEvent,
  KnowledgeRelation,
  SkillRadarPoint,
  TeamSkillMatrix,
} from './types.js';

export class SkillStore {
  constructor(private pool: Pool) {}

  async listSkillDefinitions(
    orgId: string,
    category?: string,
  ): Promise<SkillDefinition[]> {
    const params: unknown[] = [orgId];
    let query = `
      SELECT id, org_id, parent_id, name, description, category,
             max_level, level_criteria, sort_order, created_at
      FROM memory.skill_definitions
      WHERE org_id = $1
    `;
    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    query += ' ORDER BY sort_order ASC, name ASC';

    const { rows } = await this.pool.query(query, params);
    return rows.map(mapSkillDef);
  }

  async findSkillByName(
    orgId: string,
    name: string,
  ): Promise<SkillDefinition | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory.skill_definitions
       WHERE org_id = $1 AND LOWER(name) = LOWER($2)
       LIMIT 1`,
      [orgId, name],
    );
    return rows.length > 0 ? mapSkillDef(rows[0]) : null;
  }

  async getUserSkill(
    userId: string,
    skillId: string,
  ): Promise<UserSkill | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory.user_skills
       WHERE user_id = $1 AND skill_id = $2`,
      [userId, skillId],
    );
    return rows.length > 0 ? mapUserSkill(rows[0]) : null;
  }

  async getUserSkills(userId: string): Promise<UserSkill[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory.user_skills WHERE user_id = $1`,
      [userId],
    );
    return rows.map(mapUserSkill);
  }

  async upsertUserSkill(
    userId: string,
    skillId: string,
    level: number,
    confidence: number,
    evidence: SkillEvidence[],
  ): Promise<UserSkill> {
    const { rows } = await this.pool.query(
      `INSERT INTO memory.user_skills (user_id, skill_id, current_level, confidence, evidence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, skill_id)
       DO UPDATE SET current_level = $3, confidence = $4,
                     evidence = $5, updated_at = NOW(), assessed_at = NOW()
       RETURNING *`,
      [userId, skillId, level, confidence, JSON.stringify(evidence)],
    );
    return mapUserSkill(rows[0]);
  }

  async recordSkillEvent(
    userId: string,
    skillId: string,
    eventType: string,
    oldLevel: number | null,
    newLevel: number | null,
    details?: Record<string, unknown>,
  ): Promise<SkillEvent> {
    const { rows } = await this.pool.query(
      `INSERT INTO memory.skill_events (user_id, skill_id, event_type, old_level, new_level, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, skillId, eventType, oldLevel, newLevel, details ? JSON.stringify(details) : null],
    );
    return mapSkillEvent(rows[0]);
  }

  async getSkillRadar(
    userId: string,
    category?: string,
  ): Promise<SkillRadarPoint[]> {
    const params: unknown[] = [userId];
    let query = `
      SELECT sd.name AS skill, sd.max_level,
             COALESCE(us.current_level, 0) AS level,
             COALESCE(us.confidence, 0) AS confidence
      FROM memory.skill_definitions sd
      LEFT JOIN memory.user_skills us ON us.skill_id = sd.id AND us.user_id = $1
      WHERE sd.parent_id IS NULL
    `;
    if (category) {
      params.push(category);
      query += ` AND sd.category = $${params.length}`;
    }
    query += ' ORDER BY sd.sort_order ASC';

    const { rows } = await this.pool.query(query, params);
    return rows.map((r: Record<string, unknown>) => ({
      skill: r.skill as string,
      level: Number(r.level),
      maxLevel: Number(r.max_level),
      confidence: Number(r.confidence),
    }));
  }

  async getTeamMatrix(
    orgId: string,
    category?: string,
  ): Promise<TeamSkillMatrix> {
    const skills = await this.listSkillDefinitions(orgId, category);
    const topLevelSkills = skills.filter((s) => s.parentId === null);

    const params: unknown[] = [orgId];
    let skillFilter = '';
    if (category) {
      params.push(category);
      skillFilter = ` AND sd.category = $${params.length}`;
    }

    const { rows: skillRows } = await this.pool.query<{
      user_id: string;
      display_name: string | null;
      skill_name: string;
      level: number;
    }>(
      `SELECT u.id AS user_id, u.display_name, sd.name AS skill_name,
              COALESCE(us.current_level, 0) AS level
       FROM memory.users u
       CROSS JOIN memory.skill_definitions sd
       LEFT JOIN memory.user_skills us ON us.user_id = u.id AND us.skill_id = sd.id
       WHERE u.org_id = $1 AND u.is_active = TRUE
         AND sd.org_id = $1 AND sd.parent_id IS NULL${skillFilter}
       ORDER BY u.id, sd.sort_order ASC`,
      params,
    );

    const memberMap = new Map<string, TeamSkillMatrix['members'][number]>();
    for (const row of skillRows) {
      let member = memberMap.get(row.user_id);
      if (!member) {
        member = {
          userId: row.user_id,
          displayName: row.display_name ?? row.user_id,
          levels: {},
        };
        memberMap.set(row.user_id, member);
      }
      member.levels[row.skill_name] = Number(row.level);
    }

    const members = Array.from(memberMap.values());
    for (const sk of topLevelSkills) {
      for (const member of members) {
        if (member.levels[sk.name] === undefined) {
          member.levels[sk.name] = 0;
        }
      }
    }

    const gaps: TeamSkillMatrix['gaps'] = [];
    for (const sk of topLevelSkills) {
      const values = members.map((m) => m.levels[sk.name] ?? 0);
      const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      if (avg < 2) {
        gaps.push({
          skill: sk.name,
          avgLevel: Math.round(avg * 10) / 10,
          recommendation: `团队在「${sk.name}」方面整体偏弱（平均 ${avg.toFixed(1)}），建议安排培训或招聘相关人才`,
        });
      }
    }

    return {
      skills: topLevelSkills.map((s) => s.name),
      members,
      gaps,
    };
  }

  // ─── 知识图谱 ────────────────────────────────

  async addRelation(
    sourceId: string,
    sourceType: string,
    targetId: string,
    targetType: string,
    relationType: string,
    confidence: number,
    createdBy: string = 'system',
  ): Promise<KnowledgeRelation> {
    const { rows } = await this.pool.query(
      `INSERT INTO memory.knowledge_relations
       (source_id, source_type, target_id, target_type, relation_type, confidence, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [sourceId, sourceType, targetId, targetType, relationType, confidence, createdBy],
    );
    return mapRelation(rows[0]);
  }

  async getRelationsFrom(
    sourceId: string,
    sourceType: string,
    relationTypes?: string[],
  ): Promise<KnowledgeRelation[]> {
    const params: unknown[] = [sourceId, sourceType];
    let query = `
      SELECT * FROM memory.knowledge_relations
      WHERE source_id = $1 AND source_type = $2
    `;
    if (relationTypes?.length) {
      params.push(relationTypes);
      query += ` AND relation_type = ANY($${params.length})`;
    }
    query += ' ORDER BY confidence DESC, created_at DESC';

    const { rows } = await this.pool.query(query, params);
    return rows.map(mapRelation);
  }

  async getRelationsTo(
    targetId: string,
    targetType: string,
  ): Promise<KnowledgeRelation[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory.knowledge_relations
       WHERE target_id = $1 AND target_type = $2
       ORDER BY confidence DESC`,
      [targetId, targetType],
    );
    return rows.map(mapRelation);
  }

  async getKnowledgeGraph(
    centerId: string,
    centerType: string,
    depth: number = 2,
  ): Promise<{ nodes: GraphNode[]; edges: KnowledgeRelation[] }> {
    depth = Math.min(depth ?? 2, 5);
    const visited = new Set<string>();
    const allEdges: KnowledgeRelation[] = [];
    const nodeMap = new Map<string, { id: string; type: string }>();

    const queue: Array<{ id: string; type: string; d: number }> = [
      { id: centerId, type: centerType, d: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = `${current.type}:${current.id}`;
      if (visited.has(key) || current.d > depth) continue;
      visited.add(key);

      nodeMap.set(key, { id: current.id, type: current.type });

      const outgoing = await this.getRelationsFrom(current.id, current.type);
      const incoming = await this.getRelationsTo(current.id, current.type);

      for (const rel of [...outgoing, ...incoming]) {
        allEdges.push(rel);
        const nextId = rel.sourceId === current.id ? rel.targetId : rel.sourceId;
        const nextType = rel.sourceId === current.id ? rel.targetType : rel.sourceType;
        queue.push({ id: nextId, type: nextType, d: current.d + 1 });
      }
    }

    const uniqueEdges = Array.from(
      new Map(allEdges.map((e) => [e.id, e])).values(),
    );

    const allNodes = await this.enrichNodeLabels(Array.from(nodeMap.values()));
    return { nodes: allNodes, edges: uniqueEdges };
  }

  private async enrichNodeLabels(
    rawNodes: Array<{ id: string; type: string }>,
  ): Promise<GraphNode[]> {
    if (rawNodes.length === 0) return [];

    const entryIds = rawNodes.filter(n => n.type === 'entry').map(n => n.id);
    const ruleIds = rawNodes.filter(n => n.type === 'rule').map(n => n.id);
    const skillIds = rawNodes.filter(n => n.type === 'skill').map(n => n.id);

    const labelMap = new Map<string, { label: string; meta?: Record<string, unknown> }>();

    if (entryIds.length > 0) {
      const { rows } = await this.pool.query(
        `SELECT id::text, title, scope FROM memory.entries WHERE id = ANY($1::uuid[])`,
        [entryIds],
      );
      for (const r of rows) {
        labelMap.set(`entry:${r.id}`, { label: r.title as string, meta: { scope: r.scope } });
      }
    }

    if (ruleIds.length > 0) {
      const { rows } = await this.pool.query(
        `SELECT id::text, title, category FROM memory.rules WHERE id = ANY($1::uuid[])`,
        [ruleIds],
      );
      for (const r of rows) {
        labelMap.set(`rule:${r.id}`, { label: r.title as string, meta: { category: r.category } });
      }
    }

    if (skillIds.length > 0) {
      const { rows } = await this.pool.query(
        `SELECT id::text, name, category FROM memory.skill_definitions WHERE id = ANY($1::uuid[])`,
        [skillIds],
      );
      for (const r of rows) {
        labelMap.set(`skill:${r.id}`, { label: r.name as string, meta: { category: r.category } });
      }
    }

    return rawNodes.map(n => {
      const key = `${n.type}:${n.id}`;
      const info = labelMap.get(key);
      return {
        id: n.id,
        type: n.type as GraphNode['type'],
        label: info?.label ?? n.id.substring(0, 8),
        metadata: info?.meta ?? {},
      };
    });
  }

  async getSkillEvents(
    userId: string,
    limit: number = 20,
  ): Promise<SkillEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memory.skill_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map(mapSkillEvent);
  }
}

export interface GraphNode {
  id: string;
  type: 'entry' | 'rule' | 'skill';
  label: string;
  metadata?: Record<string, unknown>;
}

// ─── 行映射 ─────────────────────────────────────

function mapSkillDef(r: Record<string, unknown>): SkillDefinition {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    parentId: (r.parent_id as string) ?? null,
    name: r.name as string,
    description: (r.description as string) ?? null,
    category: r.category as SkillDefinition['category'],
    maxLevel: Number(r.max_level),
    levelCriteria: (r.level_criteria ?? []) as SkillDefinition['levelCriteria'],
    sortOrder: Number(r.sort_order),
    createdAt: String(r.created_at),
  };
}

function mapUserSkill(r: Record<string, unknown>): UserSkill {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    skillId: r.skill_id as string,
    currentLevel: Number(r.current_level),
    confidence: Number(r.confidence),
    evidence: (r.evidence ?? []) as SkillEvidence[],
    assessedAt: String(r.assessed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapSkillEvent(r: Record<string, unknown>): SkillEvent {
  return {
    id: String(r.id),
    userId: r.user_id as string,
    skillId: r.skill_id as string,
    eventType: r.event_type as string as SkillEvent['eventType'],
    oldLevel: r.old_level != null ? Number(r.old_level) : null,
    newLevel: r.new_level != null ? Number(r.new_level) : null,
    details: (r.details as Record<string, unknown>) ?? null,
    createdAt: String(r.created_at),
  };
}

function mapRelation(r: Record<string, unknown>): KnowledgeRelation {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    sourceType: r.source_type as KnowledgeRelation['sourceType'],
    targetId: r.target_id as string,
    targetType: r.target_type as KnowledgeRelation['targetType'],
    relationType: r.relation_type as KnowledgeRelation['relationType'],
    confidence: Number(r.confidence),
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdBy: r.created_by as string,
    createdAt: String(r.created_at),
  };
}
