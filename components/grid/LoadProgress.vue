<script setup lang="ts">
import type { ICellRendererParams } from 'ag-grid-community';

interface Props {
  params: ICellRendererParams;
}
const props = defineProps<Props>();

const count = ref(props.params.data.count);
const total = ref(props.params.data.total_count || Number.MAX_SAFE_INTEGER);
const completed = ref(Boolean(props.params.data.completed));

function refresh(params: ICellRendererParams): boolean {
  count.value = params.data.count;
  total.value = params.data.total_count || Number.MAX_SAFE_INTEGER;
  completed.value = Boolean(params.data.completed);
  return true;
}

defineExpose({ refresh });
</script>

<template>
  <div v-if="completed" class="mt-0">
    <UProgress color="sky" :value="count" :max="total" indicator />
  </div>
  <div v-else class="flex items-center justify-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
    <UIcon name="i-lucide:circle-alert" class="size-4 shrink-0" />
    <span>待完整核验</span>
  </div>
</template>
