import React from 'react';
import Select, { SelectOption } from '../components/Select';

// 笔刷下拉：复用通用 Select 组件（同 .mask-sync-select-* CSS、同主题变量），
// 仅在此基础上把「主文本 main」映射为 label，并透传右侧类型图标 tag。
// 之所以不用原生 <sp-picker>：其展开菜单背景在 UXP 下无法用 CSS 覆盖，
// 也无法把「混合器/涂抹」这类类型标注右对齐。复用 Select 保证与全插件下拉 100% 一致。
export interface BrushSelectOption {
  value: string;          // 笔刷预设名（PS 要求精确一致）
  main: string;           // 主文本
  tag?: React.ReactNode;  // 右侧标注（笔刷类型图标或文字；空则不显示）
}

interface Props {
  value: string;
  options: BrushSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}

export default function BrushSelect({ value, options, onChange, placeholder, title, className, style }: Props) {
  const mapped: SelectOption[] = options.map(o => ({
    value: o.value,
    label: o.main,
    tag: o.tag,
  }));
  return (
    <Select
      value={value}
      options={mapped}
      onChange={onChange}
      placeholder={placeholder}
      title={title}
      style={style}
    />
  );
}
