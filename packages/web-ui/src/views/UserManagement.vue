<script setup lang="ts">
// Created by dev on 2026/04/09
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import {
  listUsers, updateUserRole, deactivateUser,
  grantProductLineAccess, revokeProductLineAccess,
  getTopologyProductLines, resetUserPassword, unlockUser,
  type UserListItem, type ProductLineAccess,
} from '../api/client'

const authStore = useAuthStore()
const loading = ref(false)
const users = ref<UserListItem[]>([])
const allProductLines = ref<string[]>([])

const grantDialogVisible = ref(false)
const grantForm = ref({ userId: '', productLine: '', accessLevel: 'read' as 'read' | 'write' | 'manage' })
const grantTargetName = ref('')

const accessLevelOptions = [
  { value: 'read', label: '只读（查看拓扑）' },
  { value: 'write', label: '读写（修改拓扑节点/边）' },
  { value: 'manage', label: '管理（扫描/删除产品线）' },
]

const roleOptions = [
  { value: 'viewer', label: 'Viewer', color: '' },
  { value: 'developer', label: 'Developer', color: 'success' },
  { value: 'lead', label: 'Lead', color: 'warning' },
  { value: 'admin', label: 'Admin', color: 'danger' },
]

const isAllowed = computed(() => authStore.isAdmin)

async function loadData() {
  if (!isAllowed.value) return
  loading.value = true
  try {
    const [u, pls] = await Promise.all([listUsers(), getTopologyProductLines()])
    users.value = u
    allProductLines.value = pls
  } catch (err) {
    ElMessage.error('加载用户列表失败')
  } finally {
    loading.value = false
  }
}

async function handleRoleChange(user: UserListItem, newRole: string | number | boolean | undefined) {
  try {
    const role = String(newRole)
    await updateUserRole(user.id, role)
    user.role = role
    ElMessage.success(`${user.displayName ?? user.externalId} 角色已更新为 ${newRole}`)
  } catch {
    ElMessage.error('角色更新失败')
    await loadData()
  }
}

async function handleDeactivate(user: UserListItem) {
  try {
    await ElMessageBox.confirm(
      `确定要停用用户 ${user.displayName ?? user.externalId} 吗？此操作不可撤销。`,
      '停用用户',
      { type: 'warning' },
    )
    await deactivateUser(user.id)
    ElMessage.success('用户已停用')
    await loadData()
  } catch { /* 取消 */ }
}

function openGrantDialog(user: UserListItem) {
  grantForm.value = { userId: user.id, productLine: '', accessLevel: 'read' }
  grantTargetName.value = user.displayName ?? user.externalId
  grantDialogVisible.value = true
}

async function handleGrant() {
  if (!grantForm.value.productLine) {
    ElMessage.warning('请选择产品线')
    return
  }
  try {
    await grantProductLineAccess(grantForm.value.userId, grantForm.value.productLine, grantForm.value.accessLevel)
    grantDialogVisible.value = false
    ElMessage.success('权限已授予')
    await loadData()
  } catch {
    ElMessage.error('授权失败')
  }
}

async function handleResetPassword(user: UserListItem) {
  let value: string
  try {
    const result = await ElMessageBox.prompt(
      `为用户 ${user.displayName ?? user.externalId} 设置新密码`,
      '重置密码',
      { inputType: 'password', inputPlaceholder: '至少 8 位，含大写、小写字母和数字', confirmButtonText: '重置', cancelButtonText: '取消' },
    )
    value = result.value
  } catch {
    return
  }
  if (!value || value.length < 8) {
    ElMessage.warning('密码至少 8 个字符')
    return
  }
  if (!/[a-z]/.test(value)) {
    ElMessage.warning('密码必须包含至少一个小写字母')
    return
  }
  if (!/[A-Z]/.test(value)) {
    ElMessage.warning('密码必须包含至少一个大写字母')
    return
  }
  if (!/\d/.test(value)) {
    ElMessage.warning('密码必须包含至少一个数字')
    return
  }
  try {
    await resetUserPassword(user.id, value)
    ElMessage.success(`${user.displayName ?? user.externalId} 的密码已重置`)
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '密码重置失败'
    ElMessage.error(msg)
  }
}

async function handleUnlock(user: UserListItem) {
  try {
    const result = await unlockUser(user.id)
    ElMessage.success(result.message)
  } catch {
    ElMessage.error('解锁失败')
  }
}

async function handleRevoke(userId: string, pl: ProductLineAccess) {
  try {
    await ElMessageBox.confirm(
      `确定要撤销该用户对产品线「${pl.productLine}」的访问权限吗？`,
      '撤销权限',
      { type: 'warning' },
    )
    await revokeProductLineAccess(userId, pl.productLine)
    ElMessage.success('权限已撤销')
    await loadData()
  } catch { /* 取消 */ }
}


onMounted(loadData)
</script>

<template>
  <div class="user-management">
    <el-card v-if="!isAllowed">
      <el-empty description="仅管理员可访问用户管理" />
    </el-card>

    <template v-else>
      <el-card shadow="never" class="page-header">
        <div style="display: flex; align-items: center; justify-content: space-between">
          <div>
            <h3 style="margin: 0">用户管理</h3>
            <p style="margin: 4px 0 0; color: #909399; font-size: 13px">
              管理用户角色和产品线访问权限
            </p>
          </div>
          <el-button @click="loadData" :loading="loading" :icon="'Refresh'">刷新</el-button>
        </div>
      </el-card>

      <el-card shadow="never" style="margin-top: 16px" v-loading="loading">
        <el-table :data="users" stripe style="width: 100%">
          <el-table-column prop="displayName" label="用户" min-width="160">
            <template #default="{ row }">
              <div>
                <strong>{{ row.displayName ?? row.externalId }}</strong>
                <el-tag v-if="row.isSuperAdmin" size="small" type="danger" style="margin-left: 6px">Super</el-tag>
              </div>
              <div style="font-size: 12px; color: #909399">{{ row.email ?? row.externalId }}</div>
            </template>
          </el-table-column>

          <el-table-column prop="role" label="角色" width="150">
            <template #default="{ row }">
              <el-select
                :model-value="row.role"
                size="small"
                :disabled="row.id === authStore.userId || row.isSuperAdmin"
                @change="handleRoleChange(row, $event)"
              >
                <el-option
                  v-for="r in roleOptions"
                  :key="r.value"
                  :label="r.label"
                  :value="r.value"
                />
              </el-select>
            </template>
          </el-table-column>

          <el-table-column label="产品线权限" min-width="300">
            <template #default="{ row }">
              <template v-if="row.isSuperAdmin">
                <el-tag type="danger" size="small">全部产品线（Super Admin）</el-tag>
              </template>
              <template v-else-if="row.productLines?.length">
                <el-tag
                  v-for="pl in row.productLines"
                  :key="pl.productLine"
                  :type="pl.accessLevel === 'manage' ? 'danger' : pl.accessLevel === 'write' ? 'warning' : 'info'"
                  size="small"
                  closable
                  style="margin: 2px 4px 2px 0"
                  @close="handleRevoke(row.id, pl)"
                >
                  {{ pl.productLine }} ({{ pl.accessLevel }})
                </el-tag>
              </template>
              <span v-else style="color: #c0c4cc; font-size: 13px">无权限</span>
              <el-button
                v-if="!row.isSuperAdmin"
                link
                type="primary"
                size="small"
                style="margin-left: 8px"
                @click="openGrantDialog(row)"
              >
                + 添加
              </el-button>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                size="small"
                :disabled="row.id === authStore.userId"
                @click="handleUnlock(row)"
              >
                解锁
              </el-button>
              <el-button
                link
                type="warning"
                size="small"
                :disabled="row.id === authStore.userId"
                @click="handleResetPassword(row)"
              >
                重置密码
              </el-button>
              <el-button
                link
                type="danger"
                size="small"
                :disabled="row.id === authStore.userId || row.isSuperAdmin"
                @click="handleDeactivate(row)"
              >
                停用
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-dialog v-model="grantDialogVisible" title="授予产品线权限" width="450px">
        <p style="margin-bottom: 16px; color: #606266">
          为 <strong>{{ grantTargetName }}</strong> 授予产品线访问权限
        </p>
        <el-form :model="grantForm" label-width="80px">
          <el-form-item label="产品线">
            <el-select v-model="grantForm.productLine" placeholder="选择产品线" style="width: 100%">
              <el-option v-for="pl in allProductLines" :key="pl" :label="pl" :value="pl" />
            </el-select>
          </el-form-item>
          <el-form-item label="权限级别">
            <el-radio-group v-model="grantForm.accessLevel">
              <el-radio-button v-for="opt in accessLevelOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="grantDialogVisible = false">取消</el-button>
          <el-button type="primary" @click="handleGrant">确认授予</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.user-management {
  max-width: 1200px;
}
.page-header h3 {
  font-size: 18px;
}
</style>
