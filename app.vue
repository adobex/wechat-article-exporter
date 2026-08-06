<template>
  <div :class="isDev ? 'debug-screens' : ''" class="flex flex-col h-screen">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <UNotifications />
    <UModals />
  </div>
</template>

<script setup lang="ts">
import { isDev } from '~/config';
import { isSupportedChromeBrowser } from '~/utils/browser';

if (!isSupportedChromeBrowser()) {
  alert('为了更好的用户体验，推荐使用 Chrome 浏览器。');
}
</script>

<style>
@import 'style.css';
</style>
