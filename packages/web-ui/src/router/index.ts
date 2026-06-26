// Created by dev on 2026/04/05
// Copyright © 2026

import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { safeRedirect } from '../utils/safe-redirect'
import { getAccessToken } from '../utils/token-storage'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('../views/Dashboard.vue'),
    meta: { title: '仪表盘', icon: 'Odometer' },
  },
  {
    path: '/memories',
    name: 'Memories',
    component: () => import('../views/Memories.vue'),
    meta: { title: '记忆管理', icon: 'Collection' },
  },
  {
    path: '/rules',
    name: 'Rules',
    component: () => import('../views/Rules.vue'),
    meta: { title: '编码规范', icon: 'Document' },
  },
  {
    path: '/rules/:id',
    name: 'RuleDetail',
    component: () => import('../views/RuleDetail.vue'),
    meta: { title: '规则详情', hidden: true },
  },
  {
    path: '/skills',
    name: 'Skills',
    component: () => import('../views/Skills.vue'),
    meta: { title: '技能树', icon: 'TrophyBase' },
  },
  {
    path: '/knowledge-graph',
    name: 'KnowledgeGraph',
    component: () => import('../views/KnowledgeGraph.vue'),
    meta: { title: '知识图谱', icon: 'Share' },
  },
  {
    path: '/document-index',
    name: 'DocumentIndex',
    component: () => import('../views/DocumentIndex.vue'),
    meta: { title: '文档索引', icon: 'FolderOpened' },
  },
  {
    path: '/work-tracking',
    name: 'WorkTracking',
    component: () => import('../views/WorkTracking.vue'),
    meta: { title: '工作追踪', icon: 'Tickets' },
  },
  {
    path: '/tasks',
    name: 'Tasks',
    component: () => import('../views/Tasks.vue'),
    meta: { title: '任务管理', icon: 'List' },
  },
  {
    path: '/reviews',
    name: 'ReviewDashboard',
    component: () => import('../views/ReviewDashboard.vue'),
    meta: { title: '代码审查', icon: 'Checked' },
  },
  {
    path: '/webhooks',
    name: 'WebhookManagement',
    component: () => import('../views/WebhookManagement.vue'),
    meta: { title: 'Webhook 管理', icon: 'Link' },
  },
  {
    path: '/learning-log',
    name: 'LearningLog',
    component: () => import('../views/LearningLog.vue'),
    meta: { title: '学习日志', icon: 'Cpu' },
  },
  {
    path: '/topology',
    name: 'Topology',
    component: () => import('../views/topology/TopologyPage.vue'),
    meta: { title: '拓扑可视化', icon: 'Connection' },
  },
  {
    path: '/topology/:productLine/project/:repoId(.*)',
    name: 'ProjectDetail',
    component: () => import('../views/topology/components/project-detail/ProjectDetailPage.vue'),
    meta: { title: '项目详情', hidden: true },
  },
  {
    path: '/teams',
    name: 'TeamManagement',
    component: () => import('../views/TeamManagement.vue'),
    meta: { title: '团队管理', icon: 'UserFilled', requiresLead: true },
  },
  {
    path: '/users',
    name: 'UserManagement',
    component: () => import('../views/UserManagement.vue'),
    meta: { title: '用户管理', icon: 'User', requiresAdmin: true },
  },
  {
    path: '/devices',
    name: 'DeviceManagement',
    component: () => import('../views/DeviceManagement.vue'),
    meta: { title: '设备管理', icon: 'Monitor', requiresAdmin: true },
  },
  {
    path: '/audit',
    name: 'Audit',
    component: () => import('../views/Audit.vue'),
    meta: { title: '审计日志', icon: 'List', requiresAdmin: true },
  },
  {
    path: '/knowledge',
    name: 'Knowledge',
    component: () => import('../views/Knowledge.vue'),
    meta: { title: '知识管理', icon: 'Reading' },
  },
  {
    path: '/knowledge/stats',
    name: 'KnowledgeStats',
    component: () => import('../views/KnowledgeStats.vue'),
    meta: { title: '知识统计', hidden: true },
  },
  {
    path: '/knowledge/:id',
    name: 'KnowledgeDetail',
    component: () => import('../views/KnowledgeDetail.vue'),
    meta: { title: '知识详情', hidden: true },
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/Settings.vue'),
    meta: { title: '系统设置', icon: 'Setting' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('../views/NotFound.vue'),
    meta: { title: '页面未找到', hidden: true, public: true },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to, _from, next) => {
  const token = getAccessToken()
  const isPublic = to.meta.public === true

  if (!token && !isPublic) {
    next({ path: '/login', query: { redirect: to.fullPath } })
    return
  }

  if (token && to.path === '/login') {
    next(safeRedirect(typeof to.query.redirect === 'string' ? to.query.redirect : undefined))
    return
  }

  if (token && (to.meta.requiresAdmin || to.meta.requiresLead)) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      await authStore.tryResumeSession()
    }
    if (to.meta.requiresAdmin && !authStore.isAdmin) {
      next({ path: '/dashboard' })
      return
    }
    if (to.meta.requiresLead && !authStore.isLeadOrAdmin) {
      next({ path: '/dashboard' })
      return
    }
  }

  next()
})

export default router
