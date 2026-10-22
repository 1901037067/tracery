/* 测试与图标构建共用浏览器启动方法，所有浏览器配置均在临时目录。 */
import { launchBrowser as launch } from '../scripts/lib/browser.mjs';
export const launchBrowser = viewport => launch({ defaultViewport: viewport });
