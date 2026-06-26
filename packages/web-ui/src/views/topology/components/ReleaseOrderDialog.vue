<script setup lang="ts">
// Created by dev on 2026/04/08
import { Loading } from '@element-plus/icons-vue'
import type { ReleaseOrderResult } from '../types'

defineProps<{
  visible: boolean
  loading: boolean
  result: ReleaseOrderResult | null
  error: string
}>()

defineEmits<{
  'update:visible': [val: boolean]
}>()
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="发布顺序分析"
    width="600px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <div v-if="loading" style="text-align: center; padding: 30px">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <p class="loading-text">正在计算依赖关系和发布顺序…</p>
    </div>

    <div v-else-if="error" style="padding: 20px">
      <el-alert type="error" :title="error" :closable="false" />
    </div>

    <div v-else-if="result" class="release-result">
      <el-alert
        v-if="result.cycles.length > 0"
        type="warning"
        show-icon
        :closable="false"
        style="margin-bottom: 16px"
      >
        检测到循环依赖（{{ result.cycles.map(c => c.split('/').pop()).join('、') }}）！以下发布顺序为参考，请人工确认后再操作。
      </el-alert>

      <div v-for="b in result.batches" :key="b.batch" class="release-batch">
        <div class="batch-label">第 {{ b.batch }} 批</div>
        <div class="batch-items">
          <el-tag
            v-for="r in b.repos"
            :key="r"
            size="default"
            type="info"
            :title="r"
          >
            {{ r.split('/').pop() }}
          </el-tag>
        </div>
      </div>

      <div class="rollback-hint">
        回滚顺序：按上述批次的逆序执行
      </div>
    </div>

    <template v-else>
      <div class="empty-text">暂无发布顺序数据</div>
    </template>
  </el-dialog>
</template>

<style scoped>
.release-result {
  max-height: 400px;
  overflow-y: auto;
}
.release-batch {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--mf-bg-elevated, #2a2f36);
  border: 1px solid var(--mf-border, rgba(255,255,255,0.08));
}
.batch-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--mf-text-secondary, #8e949e);
  white-space: nowrap;
  min-width: 60px;
}
.batch-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.loading-text {
  margin-top: 12px;
  color: var(--mf-text-muted, #5a6170);
}
.rollback-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--mf-text-muted, #5a6170);
}
.empty-text {
  text-align: center;
  padding: 30px;
  color: var(--mf-text-muted, #5a6170);
}
</style>
