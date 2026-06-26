<script setup lang="ts">
// Created by dev on 2026/06/10
import { ref } from 'vue'

const emit = defineEmits<{
  (e: 'search', query: string, type: 'url' | 'node' | 'appkey'): void
  (e: 'clear'): void
}>()

const searchQuery = ref('')
const searchType = ref<'url' | 'node' | 'appkey'>('url')

const typeOptions = [
  { label: 'URL', value: 'url' },
  { label: '节点名', value: 'node' },
  { label: 'AppKey', value: 'appkey' },
]

function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  emit('search', q, searchType.value)
}

function doClear() {
  searchQuery.value = ''
  emit('clear')
}
</script>

<template>
  <div class="cg-search-bar">
    <el-select v-model="searchType" size="small" style="width: 100px">
      <el-option
        v-for="opt in typeOptions"
        :key="opt.value"
        :label="opt.label"
        :value="opt.value"
      />
    </el-select>
    <el-input
      v-model="searchQuery"
      size="small"
      placeholder="输入关键词搜索…"
      clearable
      style="flex: 1"
      @keyup.enter="doSearch"
      @clear="doClear"
    />
    <el-button size="small" type="primary" @click="doSearch">搜索</el-button>
  </div>
</template>

<style scoped>
.cg-search-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
