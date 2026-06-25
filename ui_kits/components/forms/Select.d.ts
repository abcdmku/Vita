import * as React from 'react';
/** Dropdown trigger (cosmetic) showing the current value with up/down chevrons. */
export interface SelectProps {
  value?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
}
export function Select(props: SelectProps): JSX.Element;
