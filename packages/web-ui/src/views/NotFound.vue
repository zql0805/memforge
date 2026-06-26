<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goHome(): void {
  router.push('/dashboard')
}
</script>

<template>
  <div class="not-found">
    <h1>404</h1>
    <p>页面不存在或已被移除</p>
    <el-button type="primary" @click="goHome">返回首页</el-button>
  </div>
</template>

<style scoped>
.not-found {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--el-text-color-primary);
}

.not-found h1 {
  margin: 0;
  font-size: 72px;
  line-height: 1;
  color: var(--el-color-primary);
}

.not-found p {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
}
</style>
