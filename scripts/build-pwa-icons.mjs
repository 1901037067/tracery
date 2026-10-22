/* 手机图标与桌面共用同一份原始标志，maskable 版本额外保留安全区。 */
import path from 'node:path';
import { generateIcons } from './lib/icon-assets.mjs';
await generateIcons(path.resolve(import.meta.dirname, '..'), { pwaOnly: true });
