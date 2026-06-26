<script setup lang="ts">
// Created by dev on 2026/05/06
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import {
  listTeams, createTeam, updateTeam, getTeamMembers, addTeamMember, removeTeamMember,
  listUsers, getTeamJoinRequests, approveJoinRequest, rejectJoinRequest,
  getTeamProductLines, addTeamProductLine, updateTeamProductLineAccess, removeTeamProductLine,
  listAllProductLines,
  type TeamInfo, type TeamMember, type UserListItem, type JoinRequest, type TeamProductLine,
} from '../api/client'
import type { ElTagType } from '../types/element-plus'

const authStore = useAuthStore()
const loading = ref(false)
const teams = ref<TeamInfo[]>([])
const users = ref<UserListItem[]>([])

const selectedTeam = ref<TeamInfo | null>(null)
const members = ref<TeamMember[]>([])
const membersLoading = ref(false)

const createDialogVisible = ref(false)
const createForm = ref({ name: '', slug: '', description: '' })
const createLoading = ref(false)

const editDialogVisible = ref(false)
const editForm = ref({ name: '', description: '' })
const editLoading = ref(false)

const addMemberDialogVisible = ref(false)
const addMemberForm = ref({ userId: '', role: 'member' as string, isPrimary: false })

const joinRequests = ref<JoinRequest[]>([])
const joinRequestsLoading = ref(false)
const activeTab = ref('members')

const teamProductLines = ref<TeamProductLine[]>([])
const teamPlLoading = ref(false)
const allProductLines = ref<string[]>([])
const addPlDialogVisible = ref(false)
const addPlForm = ref({ productLine: '', accessLevel: 'read' as 'read' | 'write' | 'manage' })

const isLeadOrAdmin = computed(() => authStore.isLeadOrAdmin)

const roleOptions: Array<{ value: string; label: string; type: ElTagType }> = [
  { value: 'owner', label: 'Owner', type: 'danger' },
  { value: 'admin', label: 'Admin', type: 'warning' },
  { value: 'member', label: 'Member', type: 'success' },
  { value: 'viewer', label: 'Viewer', type: 'info' },
]

const availableUsers = computed(() =>
  users.value.filter(u => !members.value.some(m => m.user_id === u.id)),
)

async function loadTeams() {
  loading.value = true
  try {
    const promises: [Promise<TeamInfo[]>, Promise<UserListItem[]>] = [
      listTeams(),
      isLeadOrAdmin.value ? listUsers() : Promise.resolve([]),
    ]
    const [t, u] = await Promise.all(promises)
    teams.value = t
    users.value = u
    if (t.length > 0 && !selectedTeam.value) {
      await selectTeam(t[0])
    }
  } catch {
    ElMessage.error('加载团队列表失败')
  } finally {
    loading.value = false
  }
}

async function selectTeam(team: TeamInfo) {
  selectedTeam.value = team
  membersLoading.value = true
  try {
    const [m, jr, tpl] = await Promise.all([
      getTeamMembers(team.id),
      isLeadOrAdmin.value ? getTeamJoinRequests(team.id, 'pending').catch(() => []) : Promise.resolve([]),
      isLeadOrAdmin.value ? getTeamProductLines(team.id).catch(() => []) : Promise.resolve([]),
    ])
    members.value = m
    joinRequests.value = jr as JoinRequest[]
    teamProductLines.value = tpl as TeamProductLine[]
  } catch {
    ElMessage.error('加载团队成员失败')
  } finally {
    membersLoading.value = false
  }
}

function openCreate() {
  createForm.value = { name: '', slug: '', description: '' }
  createDialogVisible.value = true
}

function autoSlug() {
  createForm.value.slug = createForm.value.name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
}

async function handleCreate() {
  if (!createForm.value.name || !createForm.value.slug) {
    ElMessage.warning('名称和标识符必填')
    return
  }
  createLoading.value = true
  try {
    const team = await createTeam(createForm.value.name, createForm.value.slug, createForm.value.description)
    ElMessage.success('团队创建成功')
    createDialogVisible.value = false
    teams.value.push({ ...team, member_count: 0 })
    await selectTeam(team)
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } }
    ElMessage.error(axiosErr.response?.data?.error ?? '创建失败')
  } finally {
    createLoading.value = false
  }
}

function openEditTeam() {
  if (!selectedTeam.value) return
  editForm.value = { name: selectedTeam.value.name, description: selectedTeam.value.description ?? '' }
  editDialogVisible.value = true
}

async function handleEditTeam() {
  if (!selectedTeam.value || !editForm.value.name) {
    ElMessage.warning('名称必填')
    return
  }
  editLoading.value = true
  try {
    const updated = await updateTeam(selectedTeam.value.id, editForm.value.name, editForm.value.description)
    const idx = teams.value.findIndex(t => t.id === updated.id)
    if (idx >= 0) {
      teams.value[idx] = { ...teams.value[idx], name: updated.name, description: updated.description }
    }
    selectedTeam.value = { ...selectedTeam.value, name: updated.name, description: updated.description }
    editDialogVisible.value = false
    ElMessage.success('团队信息已更新')
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } }
    ElMessage.error(axiosErr.response?.data?.error ?? '更新失败')
  } finally {
    editLoading.value = false
  }
}

function openAddMember() {
  addMemberForm.value = { userId: '', role: 'member', isPrimary: false }
  addMemberDialogVisible.value = true
}

async function handleAddMember() {
  if (!selectedTeam.value || !addMemberForm.value.userId) return
  try {
    await addTeamMember(
      selectedTeam.value.id,
      addMemberForm.value.userId,
      addMemberForm.value.role,
      addMemberForm.value.isPrimary,
    )
    ElMessage.success('成员已添加')
    addMemberDialogVisible.value = false
    members.value = await getTeamMembers(selectedTeam.value.id)
  } catch {
    ElMessage.error('添加成员失败')
  }
}

async function handleRemoveMember(userId: string, name: string) {
  if (!selectedTeam.value) return
  try {
    await ElMessageBox.confirm(`确认将 ${name} 移出团队？`, '移除确认')
    await removeTeamMember(selectedTeam.value.id, userId)
    ElMessage.success('已移除')
    members.value = await getTeamMembers(selectedTeam.value.id)
  } catch {
    // 取消
  }
}

async function handleApproveRequest(requestId: string) {
  try {
    await approveJoinRequest(requestId)
    ElMessage.success('已批准')
    if (selectedTeam.value) await selectTeam(selectedTeam.value)
  } catch {
    ElMessage.error('操作失败')
  }
}

async function handleRejectRequest(requestId: string, userName: string) {
  try {
    await ElMessageBox.confirm(`确认拒绝 ${userName} 的加入申请？`, '拒绝确认')
    await rejectJoinRequest(requestId)
    ElMessage.success('已拒绝')
    if (selectedTeam.value) await selectTeam(selectedTeam.value)
  } catch {
    // 取消
  }
}

// ─── 产品线关联管理 ────────────────────

const accessLevelOptions = [
  { value: 'read', label: '只读 (read)' },
  { value: 'write', label: '读写 (write)' },
  { value: 'manage', label: '管理 (manage)' },
]

const availableProductLines = computed(() =>
  allProductLines.value.filter(pl => !teamProductLines.value.some(tpl => tpl.product_line === pl)),
)

async function openAddProductLine() {
  addPlForm.value = { productLine: '', accessLevel: 'read' }
  if (allProductLines.value.length === 0) {
    try {
      allProductLines.value = await listAllProductLines()
    } catch {
      ElMessage.error('加载产品线列表失败')
    }
  }
  addPlDialogVisible.value = true
}

async function handleAddProductLine() {
  if (!selectedTeam.value || !addPlForm.value.productLine) return
  try {
    const added = await addTeamProductLine(
      selectedTeam.value.id,
      addPlForm.value.productLine,
      addPlForm.value.accessLevel,
    )
    teamProductLines.value.push(added)
    addPlDialogVisible.value = false
    ElMessage.success('产品线已关联')
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } } }
    ElMessage.error(axiosErr.response?.data?.error ?? '关联失败')
  }
}

async function handleUpdatePlAccess(item: TeamProductLine, newLevel: string) {
  if (!selectedTeam.value) return
  const level = newLevel as 'read' | 'write' | 'manage'
  try {
    await updateTeamProductLineAccess(selectedTeam.value.id, item.product_line, level)
    item.access_level = level
    ElMessage.success('权限已更新')
  } catch {
    ElMessage.error('更新权限失败')
  }
}

async function handleRemoveProductLine(item: TeamProductLine) {
  if (!selectedTeam.value) return
  try {
    await ElMessageBox.confirm(`确认取消关联产品线「${item.product_line}」？`, '取消关联')
    await removeTeamProductLine(selectedTeam.value.id, item.product_line)
    teamProductLines.value = teamProductLines.value.filter(tpl => tpl.id !== item.id)
    ElMessage.success('已取消关联')
  } catch {
    // 取消
  }
}

function getRoleTag(role: string): { value: string; label: string; type: ElTagType } {
  return roleOptions.find(r => r.value === role) ?? { value: role, label: role, type: 'info' }
}

onMounted(loadTeams)
</script>

<template>
  <div class="team-management">
    <div class="page-header">
      <h2>团队管理</h2>
      <el-button v-if="isLeadOrAdmin" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        创建团队
      </el-button>
    </div>

    <el-row :gutter="20">
      <!-- 左侧：团队列表 -->
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>
            <span>团队列表</span>
          </template>
          <div v-loading="loading">
            <div
              v-for="team in teams"
              :key="team.id"
              class="team-item"
              :class="{ active: selectedTeam?.id === team.id }"
              @click="selectTeam(team)"
            >
              <div class="team-name">{{ team.name }}</div>
              <div class="team-meta">
                <el-tag size="small" type="info">{{ team.slug }}</el-tag>
                <span class="member-count">{{ team.member_count }} 成员</span>
              </div>
            </div>
            <el-empty v-if="teams.length === 0 && !loading" description="暂无团队" />
          </div>
        </el-card>
      </el-col>

      <!-- 右侧：成员 + 审批 -->
      <el-col :span="16">
        <el-card v-if="selectedTeam" shadow="never">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div style="display: flex; align-items: center; gap: 8px">
                <span>{{ selectedTeam.name }}</span>
                <el-button v-if="isLeadOrAdmin" size="small" text type="primary" @click="openEditTeam">
                  <el-icon><Edit /></el-icon>
                </el-button>
              </div>
              <el-button v-if="isLeadOrAdmin" size="small" type="primary" @click="openAddMember">
                <el-icon><Plus /></el-icon>
                添加成员
              </el-button>
            </div>
          </template>

          <el-tabs v-model="activeTab">
            <el-tab-pane label="成员列表" name="members">
              <el-table :data="members" v-loading="membersLoading" stripe>
                <el-table-column label="用户" min-width="160">
                  <template #default="{ row }">
                    <div>{{ row.display_name || row.external_id }}</div>
                    <div v-if="row.email" style="color: #999; font-size: 12px">{{ row.email }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="角色" width="120">
                  <template #default="{ row }">
                    <el-tag :type="getRoleTag(row.role).type" size="small">
                      {{ getRoleTag(row.role).label }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="主团队" width="80" align="center">
                  <template #default="{ row }">
                    <el-icon v-if="row.is_primary" color="#67c23a"><Select /></el-icon>
                  </template>
                </el-table-column>
                <el-table-column label="加入时间" width="160">
                  <template #default="{ row }">
                    {{ new Date(row.joined_at).toLocaleDateString('zh-CN') }}
                  </template>
                </el-table-column>
                <el-table-column v-if="isLeadOrAdmin" label="操作" width="80" align="center">
                  <template #default="{ row }">
                    <el-button
                      type="danger" text size="small"
                      @click="handleRemoveMember(row.user_id, row.display_name || row.external_id)"
                    >
                      移除
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-tab-pane>

            <el-tab-pane v-if="isLeadOrAdmin" name="requests">
              <template #label>
                待审批
                <el-badge v-if="joinRequests.length > 0" :value="joinRequests.length" :max="99" style="margin-left: 4px" />
              </template>
              <el-table :data="joinRequests" v-loading="joinRequestsLoading" stripe>
                <el-table-column label="申请人" min-width="160">
                  <template #default="{ row }">
                    <div>{{ row.display_name || row.external_id }}</div>
                    <div v-if="row.email" style="color: #999; font-size: 12px">{{ row.email }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="申请说明" min-width="200">
                  <template #default="{ row }">
                    <span style="color: #909399">{{ row.message || '无' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="申请时间" width="160">
                  <template #default="{ row }">
                    {{ new Date(row.created_at).toLocaleString('zh-CN') }}
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="160" align="center">
                  <template #default="{ row }">
                    <el-button type="success" size="small" @click="handleApproveRequest(row.id)">
                      批准
                    </el-button>
                    <el-button type="danger" size="small" @click="handleRejectRequest(row.id, row.display_name || row.external_id)">
                      拒绝
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-if="joinRequests.length === 0" description="暂无待审批申请" />
            </el-tab-pane>

            <el-tab-pane v-if="isLeadOrAdmin" label="产品线" name="product-lines">
              <div style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center">
                <span style="color: #606266; font-size: 13px">
                  团队关联的产品线决定了成员可访问的数据范围
                </span>
                <el-button size="small" type="primary" @click="openAddProductLine">
                  <el-icon><Plus /></el-icon>
                  关联产品线
                </el-button>
              </div>
              <el-table :data="teamProductLines" v-loading="teamPlLoading" stripe>
                <el-table-column label="产品线" prop="product_line" min-width="180" />
                <el-table-column label="权限级别" width="180">
                  <template #default="{ row }">
                    <el-select
                      :model-value="row.access_level"
                      size="small"
                      style="width: 140px"
                      @change="handleUpdatePlAccess(row, $event)"
                    >
                      <el-option
                        v-for="opt in accessLevelOptions"
                        :key="opt.value"
                        :label="opt.label"
                        :value="opt.value"
                      />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="关联时间" width="160">
                  <template #default="{ row }">
                    {{ new Date(row.created_at).toLocaleDateString('zh-CN') }}
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="80" align="center">
                  <template #default="{ row }">
                    <el-button type="danger" text size="small" @click="handleRemoveProductLine(row)">
                      取消
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-if="teamProductLines.length === 0 && !teamPlLoading" description="暂未关联产品线" />
            </el-tab-pane>
          </el-tabs>
        </el-card>
        <el-card v-else shadow="never">
          <el-empty description="请从左侧选择一个团队" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 创建团队对话框 -->
    <el-dialog v-model="createDialogVisible" title="创建团队" width="480px">
      <el-form :model="createForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="createForm.name" placeholder="如 My Team" @input="autoSlug" />
        </el-form-item>
        <el-form-item label="标识符" required>
          <el-input v-model="createForm.slug" placeholder="如 your-product-team" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="createLoading" @click="handleCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 添加成员对话框 -->
    <el-dialog v-model="addMemberDialogVisible" title="添加团队成员" width="480px">
      <el-form :model="addMemberForm" label-width="80px">
        <el-form-item label="用户" required>
          <el-select v-model="addMemberForm.userId" filterable placeholder="选择用户" style="width: 100%">
            <el-option
              v-for="u in availableUsers"
              :key="u.id"
              :label="u.displayName || u.externalId"
              :value="u.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="addMemberForm.role" style="width: 100%">
            <el-option v-for="r in roleOptions" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="主团队">
          <el-switch v-model="addMemberForm.isPrimary" />
          <span style="margin-left: 8px; color: #999; font-size: 12px">设为该用户的主团队</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addMemberDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleAddMember">添加</el-button>
      </template>
    </el-dialog>

    <!-- 关联产品线对话框 -->
    <el-dialog v-model="addPlDialogVisible" title="关联产品线" width="480px">
      <el-form :model="addPlForm" label-width="80px">
        <el-form-item label="产品线" required>
          <el-select v-model="addPlForm.productLine" filterable placeholder="选择产品线" style="width: 100%">
            <el-option
              v-for="pl in availableProductLines"
              :key="pl"
              :label="pl"
              :value="pl"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="权限">
          <el-select v-model="addPlForm.accessLevel" style="width: 100%">
            <el-option
              v-for="opt in accessLevelOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addPlDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleAddProductLine">关联</el-button>
      </template>
    </el-dialog>

    <!-- 编辑团队对话框 -->
    <el-dialog v-model="editDialogVisible" title="编辑团队" width="480px">
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="名称" required>
          <el-input v-model="editForm.name" placeholder="团队名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="editLoading" @click="handleEditTeam">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.page-header h2 {
  margin: 0;
}
.team-item {
  padding: 12px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
}
.team-item:hover {
  background: var(--el-fill-color-light);
}
.team-item.active {
  background: var(--el-color-primary-light-9);
  border-left: 3px solid var(--el-color-primary);
}
.team-name {
  font-weight: 500;
  margin-bottom: 4px;
}
.team-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #999;
}
</style>
