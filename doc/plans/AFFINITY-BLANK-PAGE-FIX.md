# 好感度调整后白屏：修复说明

日期：2026-10-22
范围：仅前端 `panel/src`，不改后端、不改数据库。

## 现象

印象页 → 「所有人」标签 → 在某人的「手动设置」数字框里输入或点上下箭头，整个面板立刻变成空白页。

## 原因

`panel/src/components/AffinityPanel.tsx:152`：

```tsx
onChange={(event) => setDrafts((current) => ({ ...current, [person.userId]: event.currentTarget.value }))}
```

`event.currentTarget` 是在**状态更新函数里**读取的。React（本项目是 19.3）在事件分发结束后会把合成事件的 `currentTarget` 置为 `null`，而更新函数要等到下一次渲染时才执行，此时读到的是 `null.value`，抛出
`TypeError: Cannot read properties of null (reading 'value')`。

面板没有任何错误边界（`panel/src/main.tsx` 直接渲染 `<App />`），渲染期异常会卸载整棵组件树，所以表现为白屏。

后端 `PATCH /api/affinity/:userId` 和 `GET /api/affinity` 的返回结构与前端类型一致，不是接口问题。

同样的写法还出现在 `panel/src/components/TagSubjectManagerDialog.tsx:108`（主题别名编辑框），也会白屏，一并修。

## 修复

### 1. 先取值，再进更新函数（必做）

`panel/src/components/AffinityPanel.tsx`：

```tsx
onChange={(event) => {
  const value = event.currentTarget.value;
  setDrafts((current) => ({ ...current, [person.userId]: value }));
}}
```

`panel/src/components/TagSubjectManagerDialog.tsx` 第 108 行同样处理（`subject.id` 那一处）。

修完后再在 `panel/src` 里全局搜一遍 `currentTarget` / `target`，确认没有其他「在 `setX((prev) => ...)` 里读事件对象」的地方；有的话同样改成先取值。

### 2. 加一个顶层错误边界（建议）

新建 `panel/src/components/ErrorBoundary.tsx`（类组件，`getDerivedStateFromError` + `componentDidCatch` 打 `console.error`），出错时显示一张卡片：「页面出错了」+ 错误信息（走 `redactSensitiveText`）+「重新加载」按钮（`location.reload()`）。

在 `panel/src/App.tsx` 里把 `<main className="main-content">` 内部的页面包起来，并用 `key={page}` 让切换页面时自动复位，这样侧栏还在，一个页面崩了不会拖垮整个面板。

### 3. 测试

- 项目测试是 `node --test`，没有 jsdom，不必为组件加 DOM 测试。
- 跑 `npm test` 和面板的类型检查 / 构建（`panel` 下的 vite build）确认通过即可。
- 不要运行 `npm start`，不要启动 QQ 或 SnowLuma。手动验证留给 AnI：重启后在「所有人」里改一个人的好感度并保存，页面不再白屏。

## 与今晚任务的关系

今晚无人值守的三个任务（面板 P0、知识第 4 步、情绪心灵能量）的计划文档都不涉及 `AffinityPanel.tsx`、`TagSubjectManagerDialog.tsx`、`main.tsx`。唯一可能重叠的是 `App.tsx`（P0 里最近改过），所以第 2 步要在那批任务提交之后，基于最新的 `App.tsx` 再改，只增加包裹，不动现有逻辑。
