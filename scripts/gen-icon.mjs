/* 把 build/icon-source.png 转为 PNG、多个尺寸的 ICO、favicon 和 PWA 图标。 */
import path from 'node:path';
import { generateIcons } from './lib/icon-assets.mjs';
await generateIcons(path.resolve(import.meta.dirname, '..'));
