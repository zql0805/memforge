// Created by dev on 2026/04/05
// Copyright © 2026

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getDistinctProjectIds } from '../api/client'

const STORAGE_KEY = 'memforge-project-context'

export const useProjectContext = defineStore('projectContext', () => {
  const selectedProductLine = ref<string>('')
  const crossProject = ref(true)
  const knownProductLines = ref<string[]>([])
  const loaded = ref(false)

  function restore(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const data = JSON.parse(saved)
        selectedProductLine.value = data.selectedProductLine ?? ''
        crossProject.value = data.crossProject ?? true
      }
    } catch { /* 忽略损坏的缓存 */ }
  }

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      selectedProductLine: selectedProductLine.value,
      crossProject: crossProject.value,
    }))
  }

  function setProductLine(pl: string): void {
    selectedProductLine.value = pl
    crossProject.value = !pl
    persist()
  }

  function clearFilter(): void {
    selectedProductLine.value = ''
    crossProject.value = true
    persist()
  }

  const queryParams = computed(() => {
    if (crossProject.value || !selectedProductLine.value) {
      return { cross_project: true }
    }
    return { product_line: selectedProductLine.value }
  })

  const productLines = computed(() => knownProductLines.value)

  async function loadProjects(): Promise<void> {
    if (loaded.value) return
    try {
      knownProductLines.value = await getDistinctProjectIds()
      // 校验缓存的选中值是否在当前可用列表中，不在则清空
      if (selectedProductLine.value && !knownProductLines.value.includes(selectedProductLine.value)) {
        selectedProductLine.value = ''
        crossProject.value = true
        persist()
      }
    } catch { /* 服务不可用时静默 */ }
    loaded.value = true
  }

  restore()

  // knownProjects 保留为空数组以兼容仍在使用它的视图（LearningLog、WorkTracking）
  const knownProjects = computed(() => [] as Array<{ label: string; path: string; techStack?: string; productLine?: string }>)

  return {
    selectedProductLine,
    crossProject,
    knownProjects,
    productLines,
    queryParams,
    setProductLine,
    clearFilter,
    loadProjects,
  }
})
