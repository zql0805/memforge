<script setup lang="ts">
// Created by dev on 2026/04/05
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { changeMyPassword, updateMyProfile, listTeams, submitJoinRequest, getMyJoinRequests, setUnauthorizedCallback, type TeamInfo, type JoinRequest } from './api/client'
import { ElMessage } from 'element-plus'
import { safeRedirect } from './utils/safe-redirect'

const isCollapse = ref(false)
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const loginDialogVisible = ref(false)
const loginForm = ref({ externalId: '', password: '', displayName: '' })

const changePwDialogVisible = ref(false)
const changePwForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' })
const changePwLoading = ref(false)

const nicknameDialogVisible = ref(false)
const nicknameForm = ref({ displayName: '' })
const nicknameLoading = ref(false)

// 团队选择相关
const teamSelectDialogVisible = ref(false)
const availableTeams = ref<TeamInfo[]>([])
const selectedTeamId = ref<string | null>(null)
const joinMessage = ref('')
const teamSelectLoading = ref(false)
const myJoinRequests = ref<JoinRequest[]>([])
const pendingApprovalVisible = ref(false)

interface MenuItem {
  path: string
  title: string
  icon: string
  requiresAdmin?: boolean
  requiresLead?: boolean
}

const allMenuGroups: Array<{ label: string; items: MenuItem[] }> = [
  {
    label: '核心数据',
    items: [
      { path: '/dashboard', title: '仪表盘', icon: 'Odometer' },
      { path: '/memories', title: '记忆管理', icon: 'Collection' },
      { path: '/rules', title: '规范管理', icon: 'Document' },
    ],
  },
  {
    label: '开发工具',
    items: [
      { path: '/reviews', title: '代码审查', icon: 'Checked' },
      { path: '/webhooks', title: 'Webhook 管理', icon: 'Link', requiresAdmin: true },
      { path: '/knowledge-graph', title: '知识图谱', icon: 'Share' },
    ],
  },
  {
    label: '知识库',
    items: [
      { path: '/knowledge', title: '知识管理', icon: 'Reading' },
      { path: '/knowledge/stats', title: '知识统计', icon: 'DataAnalysis' },
      { path: '/topology', title: '产品线拓扑', icon: 'Connection' },
      { path: '/document-index', title: '文档索引', icon: 'FolderOpened' },
    ],
  },
  {
    label: '个人追踪',
    items: [
      { path: '/skills', title: '开发者画像', icon: 'UserFilled' },
      { path: '/work-tracking', title: '工作追踪', icon: 'Tickets' },
      { path: '/tasks', title: '任务管理', icon: 'List' },
      { path: '/learning-log', title: '学习日志', icon: 'Cpu' },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/teams', title: '团队管理', icon: 'UserFilled', requiresLead: true },
      { path: '/users', title: '用户管理', icon: 'User', requiresAdmin: true },
      { path: '/devices', title: '设备管理', icon: 'Monitor', requiresAdmin: true },
      { path: '/audit', title: '审计日志', icon: 'List', requiresAdmin: true },
      { path: '/settings', title: '系统设置', icon: 'Setting' },
    ],
  },
]

const menuGroups = computed(() => {
  if (!authStore.isAuthenticated || authStore.needsTeamSetup) return []
  return allMenuGroups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (item.requiresAdmin) return authStore.isAdmin
      if (item.requiresLead) return authStore.isLeadOrAdmin
      return true
    }),
  })).filter(group => group.items.length > 0)
})

const activeMenu = computed(() => route.path)

function handleMenuSelect(index: string) {
  router.push(index)
}

async function handleLogin(): Promise<void> {
  if (!loginForm.value.externalId.trim()) {
    ElMessage.warning('请输入用户 ID')
    return
  }
  if (!loginForm.value.password) {
    ElMessage.warning('请输入密码')
    return
  }
  try {
    const { isNewUser, teamStatus } = await authStore.connect(
      loginForm.value.externalId,
      loginForm.value.password,
      loginForm.value.displayName || undefined,
    )
    if (authStore.devicePending) {
      return
    }
    if (authStore.deviceRevoked) {
      return
    }
    loginDialogVisible.value = false

    if (teamStatus === 'needs_team_selection') {
      await loadTeamsForSelection()
      teamSelectDialogVisible.value = true
      ElMessage.info(isNewUser ? '注册成功！请选择要加入的团队' : '请先选择一个团队')
    } else if (teamStatus === 'pending_approval') {
      await loadMyJoinRequests()
      pendingApprovalVisible.value = true
    } else {
      ElMessage.success(isNewUser ? '注册成功，欢迎使用 Memforge！' : '登录成功')
      router.push(safeRedirect(typeof route.query.redirect === 'string' ? route.query.redirect : undefined))
    }
  } catch {
    // loginError 已在 store 中设置
  }
}

async function loadTeamsForSelection(): Promise<void> {
  try {
    availableTeams.value = await listTeams()
  } catch {
    ElMessage.error('加载团队列表失败')
  }
}

async function loadMyJoinRequests(): Promise<void> {
  try {
    myJoinRequests.value = await getMyJoinRequests()
  } catch (e) {
    console.error('加载加入申请失败:', e)
  }
}

async function handleSubmitJoinRequest(): Promise<void> {
  if (!selectedTeamId.value) {
    ElMessage.warning('请选择一个团队')
    return
  }
  teamSelectLoading.value = true
  try {
    await submitJoinRequest(selectedTeamId.value, joinMessage.value || undefined)
    teamSelectDialogVisible.value = false
    authStore.teamStatus = 'pending_approval'
    await loadMyJoinRequests()
    pendingApprovalVisible.value = true
    ElMessage.success('已提交加入申请，请等待团队管理员审批')
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { message?: string } } }
    ElMessage.error(axiosErr.response?.data?.message ?? '提交申请失败')
  } finally {
    teamSelectLoading.value = false
  }
}

async function handleRefreshApprovalStatus(): Promise<void> {
  await authStore.fetchUser()
  if (authStore.teamStatus === 'active') {
    pendingApprovalVisible.value = false
    ElMessage.success('审批已通过，欢迎使用 Memforge！')
    router.push('/dashboard')
  } else {
    await loadMyJoinRequests()
    ElMessage.info('申请仍在审批中，请耐心等待')
  }
}

function handleRetryLogin(): void {
  authStore.clearDeviceState()
}

async function handleChangePassword(): Promise<void> {
  const { oldPassword, newPassword, confirmPassword } = changePwForm.value
  if (!oldPassword || !newPassword) {
    ElMessage.warning('请填写完整')
    return
  }
  if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
    ElMessage.warning('密码至少 8 个字符，且包含字母和数字')
    return
  }
  if (newPassword !== confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }
  changePwLoading.value = true
  try {
    await changeMyPassword(oldPassword, newPassword)
    ElMessage.success('密码修改成功')
    changePwDialogVisible.value = false
    changePwForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' }
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { message?: string } } }
    ElMessage.error(axiosErr.response?.data?.message ?? '密码修改失败')
  } finally {
    changePwLoading.value = false
  }
}

function openNicknameDialog(): void {
  nicknameForm.value.displayName = authStore.user?.display_name ?? ''
  nicknameDialogVisible.value = true
}

async function handleUpdateNickname(): Promise<void> {
  const name = nicknameForm.value.displayName.trim()
  if (!name) {
    ElMessage.warning('昵称不能为空')
    return
  }
  if (name.length > 50) {
    ElMessage.warning('昵称不能超过 50 个字符')
    return
  }
  nicknameLoading.value = true
  try {
    await updateMyProfile(name)
    authStore.updateDisplayName(name)
    ElMessage.success('昵称已修改')
    nicknameDialogVisible.value = false
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { message?: string } } }
    ElMessage.error(axiosErr.response?.data?.message ?? '昵称修改失败')
  } finally {
    nicknameLoading.value = false
  }
}

function handleLogout(): void {
  authStore.logout()
  loginForm.value = { externalId: '', password: '', displayName: '' }
  loginDialogVisible.value = true
  router.push('/login')
  ElMessage.info('已退出登录')
}

onMounted(async () => {
  setUnauthorizedCallback(() => {
    authStore.logout()
    loginForm.value = { externalId: '', password: '', displayName: '' }
    loginDialogVisible.value = true
  })

  const resumed = await authStore.tryResumeSession()
  if (!resumed) {
    loginDialogVisible.value = true
  } else if (authStore.teamStatus === 'needs_team_selection') {
    await loadTeamsForSelection()
    teamSelectDialogVisible.value = true
  } else if (authStore.teamStatus === 'pending_approval') {
    await loadMyJoinRequests()
    pendingApprovalVisible.value = true
  }
})
</script>

<template>
  <el-container class="app-container">
    <el-aside :width="isCollapse ? '64px' : '220px'" class="app-aside">
      <div class="logo-container">
        <el-icon :size="28" color="#409eff"><Cpu /></el-icon>
        <span v-show="!isCollapse" class="logo-text">Memforge</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="isCollapse"
        background-color="#1d1e1f"
        text-color="#bfcbd9"
        active-text-color="#409eff"
        router
        @select="handleMenuSelect"
      >
        <template v-for="group in menuGroups" :key="group.label">
          <el-menu-item-group :title="isCollapse ? '' : group.label">
            <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.title }}</template>
            </el-menu-item>
          </el-menu-item-group>
        </template>
      </el-menu>

      <div class="collapse-btn" @click="isCollapse = !isCollapse">
        <el-icon><Fold v-if="!isCollapse" /><Expand v-else /></el-icon>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="route.meta.title">{{ route.meta.title }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <template v-if="authStore.isAuthenticated">
            <el-tag type="success" size="small" style="margin-right: 12px">
              {{ authStore.user?.display_name ?? authStore.user?.email ?? '已连接' }}
            </el-tag>
            <el-dropdown>
              <el-avatar :size="32" icon="UserFilled" />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item disabled>{{ authStore.user?.role ?? 'developer' }}</el-dropdown-item>
                  <el-dropdown-item divided @click="openNicknameDialog">修改昵称</el-dropdown-item>
                  <el-dropdown-item @click="changePwDialogVisible = true">修改密码</el-dropdown-item>
                  <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <el-button v-else type="primary" size="small" @click="loginDialogVisible = true">
            登录
          </el-button>
        </div>
      </el-header>

      <el-main class="app-main">
        <template v-if="authStore.needsTeamSetup && authStore.isAuthenticated">
          <div style="display: flex; align-items: center; justify-content: center; height: 60vh; flex-direction: column; color: #909399">
            <el-icon :size="64" color="#e6a23c"><Warning /></el-icon>
            <h2 style="margin: 16px 0 8px; color: #ccc">需要加入团队</h2>
            <p>请先完成团队选择和审批流程，才能使用系统功能。</p>
          </div>
        </template>
        <router-view v-else-if="authStore.isAuthenticated" :key="authStore.userId ?? 'anon'" />
      </el-main>
    </el-container>

    <el-dialog v-model="loginDialogVisible" title="登录 Memforge" width="420px" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="authStore.isAuthenticated">
      <!-- 设备等待审批状态 -->
      <div v-if="authStore.devicePending" style="text-align: center; padding: 20px 0">
        <el-icon :size="48" color="#e6a23c"><Warning /></el-icon>
        <h3 style="margin: 16px 0 8px">设备等待管理员审批</h3>
        <p style="color: #909399; font-size: 14px; margin-bottom: 16px">
          新设备首次访问需要管理员审批后才能使用。
        </p>
        <el-descriptions :column="1" border size="small" style="text-align: left">
          <el-descriptions-item label="设备 ID">
            <code style="font-size: 12px">{{ authStore.pendingDeviceId?.slice(0, 8) }}...</code>
          </el-descriptions-item>
        </el-descriptions>
        <p style="color: #c0c4cc; font-size: 12px; margin-top: 12px">
          请联系管理员在「设备管理」页面中批准你的设备，或等待审批通过后重试登录。
        </p>
      </div>

      <!-- 设备已吊销状态 -->
      <div v-else-if="authStore.deviceRevoked" style="text-align: center; padding: 20px 0">
        <el-icon :size="48" color="#f56c6c"><CircleClose /></el-icon>
        <h3 style="margin: 16px 0 8px">设备已被吊销</h3>
        <p style="color: #909399; font-size: 14px">
          此设备的访问权限已被管理员吊销，请联系管理员恢复访问。
        </p>
      </div>

      <!-- 正常登录表单 -->
      <div v-else>
        <el-alert v-if="authStore.loginError" type="error" :title="authStore.loginError" :closable="false" style="margin-bottom: 16px" />
        <el-alert v-else type="info" :closable="false" style="margin-bottom: 16px">
          首次登录将自动注册账号。密码至少 8 个字符，包含字母和数字。
        </el-alert>
        <el-form :model="loginForm" label-width="60px" @submit.prevent="handleLogin">
          <el-form-item label="ID">
            <el-input v-model="loginForm.externalId" placeholder="用户标识，如工号或邮箱前缀" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="loginForm.password" type="password" placeholder="至少 8 位，含字母和数字" show-password />
          </el-form-item>
          <el-form-item label="昵称">
            <el-input v-model="loginForm.displayName" placeholder="可选，用于界面显示" />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <div v-if="authStore.devicePending">
          <el-button @click="handleRetryLogin">返回登录</el-button>
          <el-button type="primary" @click="handleLogin">重试</el-button>
        </div>
        <div v-else-if="authStore.deviceRevoked">
          <el-button @click="handleRetryLogin">返回登录</el-button>
        </div>
        <div v-else>
          <el-button type="primary" :loading="authStore.isConnecting" @click="handleLogin">登录 / 注册</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="nicknameDialogVisible" title="修改昵称" width="400px">
      <el-form :model="nicknameForm" label-width="60px" @submit.prevent="handleUpdateNickname">
        <el-form-item label="昵称">
          <el-input v-model="nicknameForm.displayName" placeholder="输入新昵称" maxlength="50" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nicknameDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="nicknameLoading" @click="handleUpdateNickname">确认</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="changePwDialogVisible" title="修改密码" width="400px">
      <el-form :model="changePwForm" label-width="80px" @submit.prevent="handleChangePassword">
        <el-form-item label="旧密码">
          <el-input v-model="changePwForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="changePwForm.newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="确认密码">
          <el-input v-model="changePwForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="changePwDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="changePwLoading" @click="handleChangePassword">确认修改</el-button>
      </template>
    </el-dialog>

    <!-- 团队选择对话框（新用户注册后展示） -->
    <el-dialog v-model="teamSelectDialogVisible" title="选择团队" width="500px" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false">
      <el-alert type="info" :closable="false" style="margin-bottom: 16px">
        请选择要加入的团队。提交申请后，需要团队管理员审批通过才能使用系统功能。
      </el-alert>

      <el-radio-group v-model="selectedTeamId" style="width: 100%">
        <div v-for="team in availableTeams" :key="team.id" style="margin-bottom: 12px">
          <el-radio :value="team.id" style="width: 100%; height: auto; padding: 12px; border: 1px solid #363637; border-radius: 8px">
            <div>
              <strong>{{ team.name }}</strong>
              <el-tag size="small" type="info" style="margin-left: 8px">{{ team.member_count }} 成员</el-tag>
            </div>
            <div v-if="team.description" style="color: #909399; font-size: 12px; margin-top: 4px">{{ team.description }}</div>
          </el-radio>
        </div>
      </el-radio-group>

      <el-input
        v-model="joinMessage"
        type="textarea"
        :rows="2"
        placeholder="申请说明（可选，如：XX 部门新入职成员）"
        style="margin-top: 12px"
      />

      <template #footer>
        <el-button @click="handleLogout">退出登录</el-button>
        <el-button type="primary" :loading="teamSelectLoading" :disabled="!selectedTeamId" @click="handleSubmitJoinRequest">提交申请</el-button>
      </template>
    </el-dialog>

    <!-- 等待审批对话框 -->
    <el-dialog v-model="pendingApprovalVisible" title="等待审批" width="480px" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="false">
      <div style="text-align: center; padding: 20px 0">
        <el-icon :size="48" color="#e6a23c"><Warning /></el-icon>
        <h3 style="margin: 16px 0 8px">团队加入申请审批中</h3>
        <p style="color: #909399; font-size: 14px; margin-bottom: 16px">
          你的团队加入申请正在等待管理员审批。审批通过后即可使用所有功能。
        </p>
        <p style="color: #c0c4cc; font-size: 13px; margin-bottom: 20px">
          请联系团队 Leader 或管理员在「团队管理」页面中审批你的申请。
        </p>

        <el-table v-if="myJoinRequests.length > 0" :data="myJoinRequests" size="small" style="width: 100%">
          <el-table-column prop="team_name" label="团队" />
          <el-table-column prop="status" label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'pending' ? 'warning' : row.status === 'approved' ? 'success' : 'danger'" size="small">
                {{ row.status === 'pending' ? '审批中' : row.status === 'approved' ? '已通过' : '已拒绝' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="created_at" label="申请时间" width="160">
            <template #default="{ row }">{{ new Date(row.created_at).toLocaleString('zh-CN') }}</template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <el-button @click="handleLogout">退出登录</el-button>
        <el-button type="primary" @click="handleRefreshApprovalStatus">刷新状态</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.app-container {
  height: 100vh;
}

.app-aside {
  background: var(--mf-bg-deep);
  border-right: 1px solid var(--mf-border);
  display: flex;
  flex-direction: column;
}

.logo-container {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-bottom: 1px solid var(--mf-border);
  position: relative;
}


.logo-text {
  color: var(--mf-primary);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 2px;
}

.el-menu {
  border-right: none !important;
  flex: 1;
  overflow-y: auto;
  background: transparent !important;
}

.el-menu-item-group :deep(.el-menu-item-group__title) {
  padding: 12px 0 4px 20px;
  font-size: 10px;
  color: var(--mf-text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 600;
}

.collapse-btn {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mf-text-muted);
  cursor: pointer;
  border-top: 1px solid var(--mf-border);
}

.collapse-btn:hover {
  color: var(--mf-primary);
  background: var(--mf-primary-dim);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--mf-bg-deep);
  border-bottom: 1px solid var(--mf-border);
}

.app-main {
  background: var(--mf-bg-deepest);
  padding: 24px;
  position: relative;
  z-index: 1;
}
</style>
