<template>
  <div class="knowledge-stats-page">
    <h2>知识库统计</h2>
    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="6" v-for="(val, key) in statsByStatus" :key="key">
        <el-card shadow="hover">
          <div class="stat-card">
            <div class="stat-value">{{ val }}</div>
            <div class="stat-label">{{ statusLabels[key] || key }}</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="16">
        <el-card>
          <h3>新增趋势</h3>
          <v-chart v-if="trendOption" :option="trendOption" style="height: 300px" autoresize />
          <el-empty v-else description="暂无数据" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card>
          <h3>类型分布</h3>
          <v-chart v-if="pieOption" :option="pieOption" style="height: 300px" autoresize />
          <el-empty v-else description="暂无数据" />
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <h3>按类型明细</h3>
      <el-table :data="typeRows" stripe>
        <el-table-column prop="type" label="类型">
          <template #default="{ row }">{{ typeLabels[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column prop="count" label="条目数" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import VChart from 'vue-echarts'
import type { EChartsOption } from 'echarts'
import { use } from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { getKnowledgeStats } from '../api/client'

use([LineChart, PieChart, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer])

const statsByStatus = ref<Record<string, number>>({})
const typeRows = ref<Array<{ type: string; count: number }>>([])
const trendData = ref<Array<{ month: string; count: number }>>([])

const statusLabels: Record<string, string> = {
  draft: '草稿', published: '已发布', archived: '已归档',
}
const typeLabels: Record<string, string> = {
  faq: 'FAQ', how_to: '操作指南', troubleshooting: '排障指南',
  technical: '技术文档', incident: '故障案例', runbook: '内部 SOP', api_reference: 'API 参考',
}

const trendOption = computed<EChartsOption | null>(() => {
  if (trendData.value.length === 0) return null
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: trendData.value.map(d => d.month) },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{
      type: 'line',
      data: trendData.value.map(d => d.count),
      smooth: true,
      areaStyle: { opacity: 0.15 },
      itemStyle: { color: '#409EFF' },
    }],
  }
})

const pieOption = computed<EChartsOption | null>(() => {
  if (typeRows.value.length === 0) return null
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: typeRows.value.map(r => ({ name: typeLabels[r.type] || r.type, value: r.count })),
      label: { fontSize: 12 },
    }],
  }
})

onMounted(async () => {
  const stats = await getKnowledgeStats()
  statsByStatus.value = (stats.byStatus as Record<string, number>) ?? {}
  const byType = (stats.byType as Record<string, number>) ?? {}
  typeRows.value = Object.entries(byType).map(([type, count]) => ({ type, count }))
  trendData.value = (stats.trend as Array<{ month: string; count: number }>) ?? []
})
</script>

<style scoped>
.stat-card { text-align: center; padding: 16px 0; }
.stat-value { font-size: 32px; font-weight: bold; color: var(--el-color-primary); }
.stat-label { font-size: 14px; color: #909399; margin-top: 4px; }
</style>
