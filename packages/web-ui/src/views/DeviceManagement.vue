<script setup lang="ts">
// Created by dev on 2026/04/10
import { ref, onMounted, computed } from 'vue'
import {
  listDevices, approveDevice, revokeDevice, removeDevice,
  getDeviceVerificationStatus, type TrustedDevice,
} from '../api/client'
import { ElMessage, ElMessageBox } from 'element-plus'

const devices = ref<TrustedDevice[]>([])
const loading = ref(false)
const activeTab = ref('pending')
const deviceVerificationEnabled = ref(false)

const pendingDevices = computed(() => devices.value.filter(d => d.status === 'pending'))
const approvedDevices = computed(() => devices.value.filter(d => d.status === 'approved'))
const revokedDevices = computed(() => devices.value.filter(d => d.status === 'revoked'))

async function loadDevices() {
  loading.value = true
  try {
    const result = await listDevices()
    devices.value = result.devices
  } catch {
    ElMessage.error('加载设备列表失败')
  } finally {
    loading.value = false
  }
}

async function handleApprove(device: TrustedDevice) {
  try {
    await approveDevice(device.id)
    ElMessage.success('设备已批准')
    await loadDevices()
  } catch {
    ElMessage.error('批准失败')
  }
}

async function handleRevoke(device: TrustedDevice) {
  try {
    await ElMessageBox.confirm(
      `确定要吊销该设备的访问权限吗？用户将无法从此设备访问系统。`,
      '吊销设备',
      { type: 'warning' },
    )
    await revokeDevice(device.id)
    ElMessage.success('设备已吊销')
    await loadDevices()
  } catch (e) {
    console.error('吊销设备失败:', e)
  }
}

async function handleRemove(device: TrustedDevice) {
  try {
    await ElMessageBox.confirm(
      `确定要删除此设备记录吗？删除后该设备再次访问将重新进入审批流程。`,
      '删除设备',
      { type: 'warning' },
    )
    await removeDevice(device.id)
    ElMessage.success('设备已删除')
    await loadDevices()
  } catch (e) {
    console.error('删除设备失败:', e)
  }
}

function formatTime(t: string | null): string {
  if (!t) return '-'
  return new Date(t).toLocaleString('zh-CN')
}

function shortDeviceId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '...' + id.slice(-4) : id
}

onMounted(async () => {
  const status = await getDeviceVerificationStatus()
  deviceVerificationEnabled.value = status.enabled
  await loadDevices()
})
</script>

<template>
  <div class="device-management">
    <el-card>
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span style="font-size: 18px; font-weight: 600">设备管理</span>
          <div style="display: flex; align-items: center; gap: 12px">
            <el-tag :type="deviceVerificationEnabled ? 'success' : 'info'" size="small">
              设备验证{{ deviceVerificationEnabled ? '已启用' : '未启用' }}
            </el-tag>
            <el-button size="small" @click="loadDevices" :loading="loading">刷新</el-button>
          </div>
        </div>
      </template>

      <el-alert
        v-if="!deviceVerificationEnabled"
        type="info"
        :closable="false"
        style="margin-bottom: 16px"
      >
        设备验证当前未启用。启用方式：在服务器 .env 中设置 <code>DEVICE_VERIFICATION=true</code> 并重启 Gateway。
      </el-alert>

      <el-tabs v-model="activeTab">
        <el-tab-pane name="pending">
          <template #label>
            待审批
            <el-badge v-if="pendingDevices.length > 0" :value="pendingDevices.length" :max="99" style="margin-left: 6px" />
          </template>

          <el-table :data="pendingDevices" v-loading="loading" empty-text="无待审批设备" stripe>
            <el-table-column label="用户" min-width="120">
              <template #default="{ row }">
                <div>{{ row.displayName || row.externalId || '-' }}</div>
                <div style="color: #909399; font-size: 12px">{{ row.userRole }}</div>
              </template>
            </el-table-column>
            <el-table-column label="设备" min-width="140">
              <template #default="{ row }">
                <div>{{ row.deviceName || '未知设备' }}</div>
                <div style="color: #909399; font-size: 12px">
                  <code>{{ shortDeviceId(row.deviceId) }}</code>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="IP" prop="lastIp" width="130" />
            <el-table-column label="申请时间" width="170">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" @click="handleApprove(row)">批准</el-button>
                <el-button type="danger" size="small" plain @click="handleRemove(row)">拒绝</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="已批准" name="approved">
          <el-table :data="approvedDevices" v-loading="loading" empty-text="无已批准设备" stripe>
            <el-table-column label="用户" min-width="120">
              <template #default="{ row }">
                <div>{{ row.displayName || row.externalId || '-' }}</div>
                <div style="color: #909399; font-size: 12px">{{ row.userRole }}</div>
              </template>
            </el-table-column>
            <el-table-column label="设备" min-width="140">
              <template #default="{ row }">
                <div>{{ row.deviceName || '未知设备' }}</div>
                <div style="color: #909399; font-size: 12px">
                  <code>{{ shortDeviceId(row.deviceId) }}</code>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="IP" prop="lastIp" width="130" />
            <el-table-column label="最后活跃" width="170">
              <template #default="{ row }">{{ formatTime(row.lastSeenAt) }}</template>
            </el-table-column>
            <el-table-column label="批准时间" width="170">
              <template #default="{ row }">{{ formatTime(row.approvedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button type="warning" size="small" plain @click="handleRevoke(row)">吊销</el-button>
                <el-button type="danger" size="small" plain @click="handleRemove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="已吊销" name="revoked">
          <el-table :data="revokedDevices" v-loading="loading" empty-text="无已吊销设备" stripe>
            <el-table-column label="用户" min-width="120">
              <template #default="{ row }">
                <div>{{ row.displayName || row.externalId || '-' }}</div>
                <div style="color: #909399; font-size: 12px">{{ row.userRole }}</div>
              </template>
            </el-table-column>
            <el-table-column label="设备" min-width="140">
              <template #default="{ row }">
                <div>{{ row.deviceName || '未知设备' }}</div>
                <div style="color: #909399; font-size: 12px">
                  <code>{{ shortDeviceId(row.deviceId) }}</code>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="IP" prop="lastIp" width="130" />
            <el-table-column label="吊销时间" width="170">
              <template #default="{ row }">{{ formatTime(row.approvedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" plain @click="handleApprove(row)">恢复</el-button>
                <el-button type="danger" size="small" plain @click="handleRemove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<style scoped>
.device-management {
  max-width: 1200px;
}
code {
  background: #f5f7fa;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  color: #606266;
}
</style>
