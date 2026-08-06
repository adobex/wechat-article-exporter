import dayjs from 'dayjs';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import type { DownloadableArticle } from '~/types/types';
import { downloadArticleHTMLs, packHTMLAssets } from '~/utils';

/**
 * 批量下载合集文章
 */
export function useDownloadAlbum() {
  const loading = ref(false);
  const phase = ref();
  const downloadedCount = ref(0);
  const packedCount = ref(0);

  async function download(articles: DownloadableArticle[], filename: string) {
    loading.value = true;

    try {
      phase.value = '缓存文章正文';
      const results = await downloadArticleHTMLs(articles, (count: number) => {
        downloadedCount.value = count;
      });

      phase.value = '打包';
      const zip = new JSZip();
      for (const article of results) {
        await packHTMLAssets(
          article.fakeid,
          article.html!,
          article.title.replaceAll('.', '_'),
          zip.folder(dayjs(+article.date * 1000).format('YYYY-MM-DD') + ' ' + article.title.replace(/\//g, '_'))!
        );
        packedCount.value++;
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, `${filename}.zip`);
    } catch (e: any) {
      alert(e.message);
      console.error(e);
    } finally {
      loading.value = false;
    }
  }

  return {
    loading,
    phase,
    downloadedCount,
    packedCount,
    download,
  };
}
