<template>
  <div class="h-screen">
    <UButton
      icon="i-lucide:x"
      square
      variant="link"
      color="gray"
      class="absolute right-3 top-3"
      @click="show = false"
    ></UButton>
    <client-only>
      <iframe
        class="border-none w-full h-screen"
        :src="previewUrl"
        sandbox=""
        referrerpolicy="no-referrer"
        title="文章预览"
      ></iframe>
    </client-only>
  </div>
</template>

<script lang="ts" setup>
import DOMPurify from 'dompurify';

interface Props {
  html: string;
}
const props = defineProps<Props>();
const show = defineModel<boolean>('show', { default: false });

const previewUrl = ref('about:blank');
let objectUrl: string | null = null;

function revokeObjectUrl() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

watch(
  () => props.html,
  (newHtml: string) => {
    revokeObjectUrl();
    if (!newHtml) {
      previewUrl.value = 'about:blank';
      return;
    }
    const sanitizedHtml = DOMPurify.sanitize(newHtml, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ['script'],
      FORBID_ATTR: ['srcdoc'],
    });
    objectUrl = URL.createObjectURL(new Blob([sanitizedHtml], { type: 'text/html;charset=utf-8' }));
    previewUrl.value = objectUrl;
  },
  { immediate: true }
);

onUnmounted(revokeObjectUrl);
</script>
