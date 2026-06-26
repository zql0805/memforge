<script setup lang="ts">
// Created by dev on 2026/04/08
import { Loading } from '@element-plus/icons-vue'
import type { ChangeImpactResult } from '../types'

defineProps<{
  visible: boolean
  loading: boolean
  targetRepoId: string
  result: ChangeImpactResult | null
  error: string
}>()

defineEmits<{
  'update:visible': [val: boolean]
}>()

function shortName(repoId: string): string {
  return repoId.split('/').pop() ?? repoId
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="`变更影响分析 — ${shortName(targetRepoId)}`"
    width="600px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <div v-if="loading" style="text-align: center; padding: 30px">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <p style="margin-top: 12px; color: var(--mf-text-muted, #5a6170)">正在分析变更影响范围…</p>
    </div>

    <div v-else-if="error" style="padding: 20px">
      <el-alert type="error" :title="error" :closable="false" />
    </div>

    <div v-else-if="result" class="impact-result">
      <div class="impact-section">
        <h4>直接调用方</h4>
        <div v-if="result.directCallers.length > 0" class="impact-tags">
          <el-tag v-for="r in result.directCallers" :key="r" type="danger" effect="light">
            {{ shortName(r) }}
          </el-tag>
        </div>
        <p v-else class="no-data">无直接上游调用</p>
      </div>

      <div class="impact-section">
        <h4>间接受影响</h4>
        <div v-if="result.indirectCallers.length > 0" class="impact-tags">
          <el-tag v-for="r in result.indirectCallers" :key="r" type="warning" effect="light">
            {{ shortName(r) }}
          </el-tag>
        </div>
        <p v-else class="no-data">无间接上游依赖</p>
      </div>
    </div>

    <template v-else>
      <div style="text-align: center; padding: 30px; color: var(--mf-text-muted, #5a6170)">暂无影响分析数据</div>
    </template>
  </el-dialog>
</template>

<style scoped>
.impact-result {
  max-height: 400px;
  overflow-y: auto;
}
.impact-section {
  margin-bottom: 20px;
}
.impact-section h4 {
  font-size: 13px;
  color: var(--mf-text-primary, #e0e6ed);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--mf-border, rgba(255,255,255,0.08));
}
.impact-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.no-data { font-size: 12px; color: var(--mf-text-muted, #5a6170); }
</style>
