import { shell, storage } from 'uxp';

/**
 * 在默认浏览器中打开插件内置的本地 HTML 文档。
 *
 * 文档随插件一起打包到插件根目录下的 docs/ 内（由 webpack 的 copy 步骤拷贝）。
 * 通过 storage.localFileSystem.getPluginFolder() 定位插件真实目录，
 * 再用 shell.openPath 唤起系统默认浏览器渲染。
 *
 * @param relPath 相对于插件根目录的路径，例如 "docs/fill-guide.html"
 */
export async function openPluginDoc(relPath: string): Promise<void> {
  try {
    const folder: any = await storage.localFileSystem.getPluginFolder();
    const root: string = folder?.nativePath;
    if (!root) {
      console.warn('⚠️ 无法定位插件目录，无法打开功能文档');
      return;
    }
    const sep = root.includes('\\') ? '\\' : '/';
    const parts = relPath.split('/').filter(Boolean);
    const full = [root, ...parts].join(sep);
    const r: any = await shell.openPath(full);
    if (typeof r === 'string' && r.length > 0) {
      console.warn('⚠️ 打开功能文档失败:', r);
    }
  } catch (e) {
    console.error('打开功能文档异常:', e);
  }
}
