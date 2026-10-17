# 主题系统

EVNote 的外观 = **一套 CSS 变量**。改主题只需要改这个文件里的变量值，不用碰布局和逻辑。

```
public/themes/
├── apple.css      # 默认：Apple / macOS 风（大圆角、毛玻璃、系统蓝）
└── obsidian.css   # 备选：Obsidian 风（紫罗兰强调色、紧凑圆角）
```

## 切换主题

改 `evnote.config.json`：

```json
{
  "theme": "dark",        // 亮暗：light / dark
  "themeName": "apple"    // 皮肤：apple / obsidian
}
```

也可以在应用里按 `Ctrl+P` → 搜「切换主题皮肤」。

## 自定义主题（三步）

1. 复制 `apple.css` 为 `mytheme.css`
2. 改里面的变量（下方有速查表）
3. `"themeName": "mytheme"`

刷新即生效，服务端会自动校验文件名存在性。

## 变量速查

### 表面与文字

| 变量 | 作用 | 默认（亮色） |
|---|---|---|
| `--bg-window` | 窗口底色（纸张之外） | `#ececee` |
| `--bg-sheet` | 内容纸张底色 | `#ffffff` |
| `--bg-sidebar` | 侧栏/工具栏（配合毛玻璃） | `rgba(246,246,248,.78)` |
| `--bg-fill` | 次级填充（输入框、按钮） | `rgba(120,120,128,.10)` |
| `--bg-selected` | 选中态 | `rgba(0,122,255,.12)` |
| `--text-primary` | 正文 | `#1d1d1f` |
| `--text-secondary` | 次要文字 | `#6e6e73` |
| `--text-tertiary` | 提示/图标 | `#a1a1a6` |
| `--hairline` | 发丝分割线 | `rgba(60,60,67,.10)` |

### 强调与语义

| 变量 | 作用 |
|---|---|
| `--accent` / `--accent-hover` | 主强调色（按钮、选中、焦点环） |
| `--accent-soft` | 强调色的半透明底 |
| `--link` / `--link-unresolved` | 双链颜色 / 未解析链接颜色 |
| `--tag` / `--tag-soft` | 标签色与其底色 |
| `--mark` | 高亮（`==文字==`）底色 |
| `--danger` / `--warning` / `--success` | 语义色 |

### 形状与质感

| 变量 | 作用 |
|---|---|
| `--r-xs` … `--r-xl` | 圆角梯度（6 → 26px） |
| `--shadow-soft` / `--shadow-sheet` / `--shadow-float` | 三级阴影 |
| `--font-ui` / `--font-display` / `--font-mono` | 字体栈 |
| `--ease` / `--dur` | 动效曲线与时长 |
| `--overlay` | 模态遮罩 |

## 让 AI 帮你改

直接跟 AI 说需求即可，例如：

> 「把 `public/themes/apple.css` 里的 `--accent` 改成墨绿色，`--r-lg` 改成 12px，保持其他不变。」

AI 只需要改这个文件的变量块，不会碰布局。改完刷新页面即可看到效果。
如果改坏了，`git checkout public/themes/apple.css` 就能还原。
