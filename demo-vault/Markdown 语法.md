# Markdown 语法

EVNote 的实时预览编辑器支持以下语法。边打字边渲染，和 Obsidian 的 Live Preview 体验一致。

## 基础格式

**加粗**、*斜体*、~~删除线~~、==高亮==、`行内代码`

## 标题层级

### 三级标题

#### 四级标题

## 列表

- 无序列表项
- 另一项
  - 嵌套子项
  - 再嵌套一层

1. 有序列表
2. 第二项
3. 第三项

## 任务列表

- [x] 搭建服务端（vault 管理 + 索引）
- [x] 实现实时预览编辑器
- [x] 双链与反链
- [ ] 插件系统（见 [[EVNote 复刻计划]] 的「未实现」一节）
- [ ] 云同步

## 引用与 Callout

> 普通引用：学而不思则罔，思而不学则殆。

> [!tip] 小贴士
> Callout 是 Obsidian 的标志性功能，输入 `> [!tip] 标题` 即可触发。
> 支持 `note / tip / warning / danger / info / example` 六种类型。

## 代码块

```javascript
// EVNote 的链接解析：先按路径，再按文件名唯一匹配
function resolve(target) {
  if (notes.has(target + '.md')) return target + '.md';
  const hits = byName.get(target.toLowerCase());
  return hits?.length === 1 ? hits[0] : null;
}
```

```python
# Python 也支持
print("Hello, EVNote!")
```

## 表格

| 语法 | 效果 | 状态 |
| --- | --- | --- |
| `**文字**` | 加粗 | ✅ |
| `[[双链]]` | 内部链接 | ✅ |
| `#标签` | 标签 | ✅ |
| `![[图片]]` | 嵌入附件 | ✅ |

## 链接

- 外部链接：[Obsidian 官网](https://obsidian.md)
- 内部双链：[[双链与反链]]
- 带别名的双链：[[标签系统|去看看标签]]
- 嵌入笔记：![[常用代码]]

## 分割线

---

相关内容：[[命令面板与快捷键]] · [[双链与反链]]

#Markdown #语法 #参考