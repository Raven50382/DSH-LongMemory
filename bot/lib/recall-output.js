// MCP 召回结果裁剪：Web 控制台需要完整章动路径，模型不需要。
// 只保留模型判断所需字段，避免把 trace / entries / bests / 调试耗时塞进 token。
export function compactRecall(result) {
  if (!result || typeof result !== 'object') return result;
  const {
    runs, ms, ms_seg, ms_recall, ...brief
  } = result;
  return brief;
}
